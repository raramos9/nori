import ts from 'typescript6';
import type { NonEmpty } from '../graph/model.js';

export type PathPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'hole' };
export type PathTemplate = readonly PathPart[];
export type Evaluated =
  | { readonly kind: 'templates'; readonly alternatives: NonEmpty<PathTemplate>; readonly fromBuilder: boolean }
  | { readonly kind: 'unknown'; readonly why: string };

type Templates = Extract<Evaluated, { kind: 'templates' }>;
type Env = ReadonlyMap<ts.ParameterDeclaration, ts.Expression>;
type Source = { readonly expression: ts.Expression; readonly path: readonly string[] };

const MAX_ALTERNATIVES = 64;
const MAX_DEPTH = 14;
const ITERATORS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'some']);
const ARRAY_PASSTHROUGH = new Set(['filter', 'slice', 'concat', 'sort', 'toSorted']);
const ROUTE_BUILDER_ARGUMENT = /^\/.*\[[\w.-]+\]/;
const HOLE: PathPart = { kind: 'hole' };

function unknown(why: string): Evaluated {
  return { kind: 'unknown', why };
}

function textPart(value: string): PathTemplate {
  return value === '' ? [] : [{ kind: 'text', text: value }];
}

function text(value: string): Templates {
  return { kind: 'templates', alternatives: [textPart(value)], fromBuilder: false };
}

const ANY_STRING: Templates = { kind: 'templates', alternatives: [[HOLE]], fromBuilder: false };

function join(a: PathTemplate, b: PathTemplate): PathTemplate {
  const parts = [...a];
  for (const part of b) {
    const last = parts.at(-1);
    if (part.kind === 'text' && last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + part.text };
    else parts.push(part);
  }
  return parts;
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

function concat(a: Templates, b: Templates): Templates {
  const out: PathTemplate[] = [];
  outer: for (const x of a.alternatives) {
    for (const y of b.alternatives) {
      out.push(join(x, y));
      if (out.length >= MAX_ALTERNATIVES) break outer;
    }
  }
  const alternatives = nonEmpty(out) ?? a.alternatives;
  return { kind: 'templates', alternatives, fromBuilder: a.fromBuilder || b.fromBuilder };
}

// A non-passthrough failure wins so a weaker "param" reason never hides a real one.
function union(results: readonly Evaluated[]): Evaluated {
  const failures = results.filter((r) => r.kind === 'unknown');
  const failure = failures.find((r) => r.why !== 'param') ?? failures[0];
  if (failure !== undefined) return failure;
  const templates = results.filter((r): r is Templates => r.kind === 'templates');
  const alternatives = nonEmpty(templates.flatMap((r) => r.alternatives).slice(0, MAX_ALTERNATIVES));
  if (alternatives === null) return unknown('empty');
  return { kind: 'templates', alternatives, fromBuilder: templates.some((r) => r.fromBuilder) };
}

function loose(result: Evaluated): Templates {
  return result.kind === 'unknown' ? ANY_STRING : result;
}

function strip(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function isStringish(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isBinding(node: ts.Node): node is ts.ParameterDeclaration | ts.BindingElement {
  return ts.isParameter(node) || ts.isBindingElement(node);
}

function initializedVariable(node: ts.Node): node is ts.VariableDeclaration & { initializer: ts.Expression } {
  return ts.isVariableDeclaration(node) && node.initializer !== undefined;
}

function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => property.name !== undefined && property.name.getText() === name);
}

function propertyValue(property: ts.ObjectLiteralElementLike | undefined): ts.Expression | null {
  if (property === undefined) return null;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return null;
}

function jsxAttributeValue(attributes: ts.JsxAttributes, name: string): ts.Expression | null {
  const attribute = attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  const initializer = attribute?.initializer;
  if (initializer === undefined) return null;
  if (ts.isStringLiteral(initializer)) return initializer;
  return ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : null;
}

function functionOf(declaration: ts.Declaration): ts.FunctionLikeDeclaration | null {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration;
  if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
    const initializer = strip(declaration.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  }
  return null;
}

function returnedExpressions(body: ts.Block): readonly ts.Expression[] {
  const returns: ts.Expression[] = [];
  const find = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, find);
  };
  ts.forEachChild(body, find);
  return returns;
}

// The component a callback-wrapped function (memo, forwardRef) is bound to, which is what JSX tags resolve to.
function componentDeclaration(fn: ts.SignatureDeclaration): ts.Declaration | null {
  if (ts.isFunctionDeclaration(fn)) return fn;
  let node: ts.Node = fn;
  while (ts.isCallExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return ts.isVariableDeclaration(node.parent) ? node.parent : null;
}

export function createEvaluator(program: ts.Program): (expression: ts.Expression) => Evaluated {
  const checker = program.getTypeChecker();
  let jsxSiteIndex: Map<ts.Declaration, ts.JsxAttributes[]> | undefined;

  function declarationsOf(node: ts.Node): readonly ts.Declaration[] {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return [];
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol.declarations ?? [];
  }

  function jsxSites(fn: ts.SignatureDeclaration): readonly ts.JsxAttributes[] | undefined {
    if (jsxSiteIndex === undefined) {
      const index = new Map<ts.Declaration, ts.JsxAttributes[]>();
      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        const visit = (node: ts.Node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            for (const declaration of declarationsOf(node.tagName)) {
              const sites = index.get(declaration);
              if (sites === undefined) index.set(declaration, [node.attributes]);
              else sites.push(node.attributes);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
      }
      jsxSiteIndex = index;
    }
    const component = componentDeclaration(fn);
    return component === null ? undefined : jsxSiteIndex.get(component);
  }

  function fromType(expression: ts.Expression): Evaluated | null {
    const type = checker.getTypeAtLocation(expression);
    const types = type.isUnion() ? type.types : [type];
    const literals = types.filter((t): t is ts.StringLiteralType => t.isStringLiteral());
    if (literals.length === types.length) {
      const alternatives = nonEmpty(literals.map((t) => textPart(t.value)));
      return alternatives === null ? null : { kind: 'templates', alternatives, fromBuilder: false };
    }
    const [only] = types;
    if (types.length === 1 && only !== undefined && only.flags & ts.TypeFlags.TemplateLiteral) {
      const template = only as ts.TemplateLiteralType;
      let parts = textPart(template.texts[0] ?? '');
      template.types.forEach((_, i) => {
        parts = join(parts, [HOLE, ...textPart(template.texts[i + 1] ?? '')]);
      });
      return { kind: 'templates', alternatives: [parts], fromBuilder: false };
    }
    return null;
  }

  function withType(result: Evaluated, expression: ts.Expression): Evaluated {
    if (result.kind === 'templates') return result;
    return fromType(expression) ?? result;
  }

  function sources(declaration: ts.Node, path: readonly string[], env: Env, depth: number): Source[] | null {
    let node = declaration;
    const props = [...path];
    while (ts.isBindingElement(node)) {
      props.unshift((node.propertyName ?? node.name).getText());
      node = node.parent.parent;
    }
    if (ts.isVariableDeclaration(node)) return node.initializer ? [{ expression: node.initializer, path: props }] : null;
    if (!ts.isParameter(node)) return null;
    const bound = env.get(node);
    if (bound !== undefined) return [{ expression: bound, path: props }];
    const fn = node.parent;
    if (fn.parameters[0] !== node) return null;
    const call = fn.parent;
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      ITERATORS.has(call.expression.name.text)
    ) {
      const items = elements(call.expression.expression, env, depth + 1);
      return items === null ? null : items.map((expression) => ({ expression, path: props }));
    }
    const [prop, ...rest] = props;
    if (prop === undefined) return null;
    const sites = jsxSites(fn);
    if (sites === undefined || sites.length === 0) return null;
    const out: Source[] = [];
    for (const attributes of sites) {
      const expression = jsxAttributeValue(attributes, prop);
      if (expression === null) return null;
      out.push({ expression, path: rest });
    }
    return out;
  }

  function follow(expression: ts.Expression, path: readonly string[], env: Env, depth: number): ts.Expression[] | null {
    const [prop, ...rest] = path;
    if (prop === undefined) return [expression];
    const objs = objects(expression, env, depth + 1);
    if (objs === null) return null;
    const out: ts.Expression[] = [];
    for (const object of objs) {
      const value = propertyValue(propertyNamed(object, prop));
      if (value === null) return null;
      const followed = follow(value, rest, env, depth + 1);
      if (followed === null) return null;
      out.push(...followed);
    }
    return out;
  }

  function viaSources<T>(
    declaration: ts.Node,
    env: Env,
    depth: number,
    collect: (expression: ts.Expression) => T[] | null,
  ): T[] | null {
    const found = depth > MAX_DEPTH ? null : sources(declaration, [], env, depth);
    if (found === null) return null;
    const out: T[] = [];
    for (const source of found) {
      const expressions = follow(source.expression, source.path, env, depth);
      if (expressions === null) return null;
      for (const expression of expressions) {
        const collected = collect(expression);
        if (collected === null) return null;
        out.push(...collected);
      }
    }
    return out;
  }

  function paramBinding(declaration: ts.Node, prop: string | null, env: Env, depth: number): Evaluated {
    const found = sources(declaration, prop === null ? [] : [prop], env, depth);
    if (found === null) return unknown(isBinding(declaration) ? 'param' : 'binding');
    return union(found.map((source) => getProps(source.expression, source.path, env, depth + 1)));
  }

  function getProps(expression: ts.Expression, props: readonly string[], env: Env, depth: number): Evaluated {
    const [prop, ...rest] = props;
    if (prop === undefined) return evaluate(expression, env, depth);
    const objs = objects(expression, env, depth);
    if (objs === null) return unknown('object');
    return union(
      objs.map((object) => {
        const property = propertyNamed(object, prop);
        if (property === undefined) return unknown('missing-prop');
        const value = propertyValue(property);
        return value === null ? unknown('prop-kind') : getProps(value, rest, env, depth + 1);
      }),
    );
  }

  function elements(expression: ts.Expression, env: Env, depth: number): ts.Expression[] | null {
    const e = strip(expression);
    if (depth > MAX_DEPTH) return null;
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((element) =>
        ts.isSpreadElement(element) ? (elements(element.expression, env, depth + 1) ?? []) : [element],
      );
    }
    if (ts.isIdentifier(e)) {
      const declarations = declarationsOf(e);
      const variable = declarations.find(
        (d): d is ts.VariableDeclaration & { initializer: ts.Expression } =>
          initializedVariable(d) && ts.isIdentifier(d.name),
      );
      if (variable !== undefined) return elements(variable.initializer, env, depth + 1);
      const binding = declarations.find(isBinding);
      return binding === undefined
        ? null
        : viaSources(binding, env, depth + 1, (item) => elements(item, env, depth + 1));
    }
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ARRAY_PASSTHROUGH.has(e.expression.name.text)
    ) {
      return elements(e.expression.expression, env, depth + 1);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const assignments = declarationsOf(e.name).filter(ts.isPropertyAssignment);
      if (assignments.length > 0) {
        return assignments.flatMap((a) => elements(a.initializer, env, depth + 1) ?? []);
      }
      const values = follow(e.expression, [e.name.text], env, depth + 1);
      if (values !== null) return values.flatMap((value) => elements(value, env, depth + 1) ?? []);
    }
    return null;
  }

  function objects(expression: ts.Expression, env: Env, depth: number): ts.ObjectLiteralExpression[] | null {
    const e = strip(expression);
    if (depth > MAX_DEPTH) return null;
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isIdentifier(e)) {
      const declarations = declarationsOf(e);
      const variable = declarations.find(initializedVariable);
      if (variable !== undefined) return objects(variable.initializer, env, depth + 1);
      const binding = declarations.find(isBinding);
      return binding === undefined
        ? null
        : viaSources(binding, env, depth + 1, (item) => objects(item, env, depth + 1));
    }
    if (ts.isPropertyAccessExpression(e)) {
      const assignments = declarationsOf(e.name).filter(ts.isPropertyAssignment);
      if (assignments.length > 0) {
        return assignments.flatMap((a) => objects(a.initializer, env, depth + 1) ?? []);
      }
      const bases = objects(e.expression, env, depth + 1);
      if (bases === null) return null;
      return bases.flatMap((base) => {
        const property = propertyNamed(base, e.name.text);
        return property !== undefined && ts.isPropertyAssignment(property)
          ? (objects(property.initializer, env, depth + 1) ?? [])
          : [];
      });
    }
    if (ts.isElementAccessExpression(e)) {
      const items = elements(e.expression, env, depth + 1);
      if (items !== null) return items.flatMap((item) => objects(item, env, depth + 1) ?? []);
    }
    return null;
  }

  function callReturn(call: ts.CallExpression, env: Env, depth: number): Evaluated {
    const callee = call.expression;
    const declarations = ts.isIdentifier(callee)
      ? declarationsOf(callee)
      : ts.isPropertyAccessExpression(callee)
        ? declarationsOf(callee.name)
        : [];
    let fn: ts.FunctionLikeDeclaration | null = null;
    for (const declaration of declarations) fn = functionOf(declaration) ?? fn;
    if (fn === null || fn.body === undefined) return unknown('call');
    const inner = new Map(env);
    fn.parameters.forEach((parameter, i) => {
      const argument = call.arguments[i];
      if (argument !== undefined) inner.set(parameter, argument);
    });
    if (!ts.isBlock(fn.body)) return evaluate(fn.body, inner, depth + 1);
    const returns = returnedExpressions(fn.body);
    if (returns.length === 0) return unknown('call');
    return union(returns.map((expression) => evaluate(expression, inner, depth + 1)));
  }

  function routeBuilderLiteral(call: ts.CallExpression): Evaluated | null {
    for (const argument of call.arguments) {
      const e = strip(argument);
      if (isStringish(e) && ROUTE_BUILDER_ARGUMENT.test(e.text)) return { ...text(e.text), fromBuilder: true };
    }
    return null;
  }

  function viaBinding(e: ts.PropertyAccessExpression, env: Env, depth: number): Evaluated | null {
    const chain: string[] = [];
    let base: ts.Expression = e;
    while (ts.isPropertyAccessExpression(base)) {
      chain.unshift(base.name.text);
      base = strip(base.expression);
    }
    const binding = ts.isIdentifier(base) ? declarationsOf(base).find(isBinding) : undefined;
    if (binding === undefined) {
      const result = getProps(base, chain, env, depth);
      return result.kind === 'templates' ? result : null;
    }
    const [only] = chain;
    return withType(
      chain.length === 1 && only !== undefined ? paramBinding(binding, only, env, depth) : getProps(base, chain, env, depth),
      e,
    );
  }

  // A property's declarations come from the checker's merged type, which for an array of object literals
  // keeps only one element's declaration, so a binding traced to its sources is tried first.
  function member(e: ts.PropertyAccessExpression | ts.ElementAccessExpression, env: Env, depth: number): Evaluated {
    const traced = ts.isPropertyAccessExpression(e) ? viaBinding(e, env, depth) : null;
    if (traced?.kind === 'templates') return traced;
    const nameNode = ts.isPropertyAccessExpression(e) ? e.name : e.argumentExpression;
    const declarations = declarationsOf(nameNode);
    const valued = declarations.filter(
      (d): d is ts.PropertyAssignment | (ts.EnumMember & { initializer: ts.Expression }) =>
        ts.isPropertyAssignment(d) || (ts.isEnumMember(d) && d.initializer !== undefined),
    );
    if (valued.length > 0 && valued.length === declarations.length) {
      return union(valued.map((d) => evaluate(d.initializer, env, depth + 1)));
    }
    return traced ?? withType(unknown('member'), e);
  }

  function identifier(e: ts.Identifier, env: Env, depth: number): Evaluated {
    const declarations = declarationsOf(e);
    const variable = declarations.find(initializedVariable);
    if (variable !== undefined) return evaluate(variable.initializer, env, depth + 1);
    const binding = declarations.find(isBinding);
    if (binding !== undefined) return withType(paramBinding(binding, null, env, depth), e);
    const enumMember = declarations.find(
      (d): d is ts.EnumMember & { initializer: ts.Expression } => ts.isEnumMember(d) && d.initializer !== undefined,
    );
    if (enumMember !== undefined) return evaluate(enumMember.initializer, env, depth + 1);
    return withType(unknown(declarations.length > 0 ? 'decl' : 'unknown-symbol'), e);
  }

  function call(e: ts.CallExpression, env: Env, depth: number): Evaluated {
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'toString' || callee.name.text === 'trim')) {
      return evaluate(callee.expression, env, depth + 1);
    }
    const [first] = e.arguments;
    if (ts.isIdentifier(callee) && callee.text === 'String' && first !== undefined) {
      return evaluate(first, env, depth + 1);
    }
    const result = withType(callReturn(e, env, depth), e);
    if (result.kind === 'templates') return result;
    return routeBuilderLiteral(e) ?? result;
  }

  function evaluate(expression: ts.Expression, env: Env, depth: number): Evaluated {
    const e = strip(expression);
    if (depth > MAX_DEPTH) return unknown('depth');
    if (isStringish(e)) return text(e.text);
    if (ts.isTemplateExpression(e)) {
      let acc = text(e.head.text);
      for (const span of e.templateSpans) {
        acc = concat(concat(acc, loose(evaluate(span.expression, env, depth + 1))), text(span.literal.text));
      }
      return acc;
    }
    if (ts.isBinaryExpression(e)) {
      const operator = e.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) {
        const left = evaluate(e.left, env, depth + 1);
        if (left.kind === 'unknown') return left;
        return concat(left, loose(evaluate(e.right, env, depth + 1)));
      }
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
        const right = evaluate(e.right, env, depth + 1);
        const left = evaluate(e.left, env, depth + 1);
        if (left.kind === 'unknown') return right.kind === 'unknown' ? left : right;
        return union([left, right]);
      }
    }
    if (ts.isConditionalExpression(e)) {
      return union([evaluate(e.whenTrue, env, depth + 1), evaluate(e.whenFalse, env, depth + 1)]);
    }
    if (ts.isObjectLiteralExpression(e)) {
      const pathname = propertyNamed(e, 'pathname');
      return pathname !== undefined && ts.isPropertyAssignment(pathname)
        ? evaluate(pathname.initializer, env, depth + 1)
        : unknown('object');
    }
    if (ts.isIdentifier(e)) return identifier(e, env, depth);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return member(e, env, depth);
    if (ts.isCallExpression(e)) return call(e, env, depth);
    return withType(unknown(`expr:${ts.SyntaxKind[e.kind]}`), e);
  }

  return (expression) => evaluate(expression, new Map(), 0);
}
