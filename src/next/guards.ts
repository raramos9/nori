import ts from 'typescript6';
import type { MatchRoute, MatchSegment } from './match.js';

export type Truth = 'always' | 'never' | 'unknown';

type Value =
  | { readonly kind: 'pathname' }
  | { readonly kind: 'params' }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'string'; readonly pattern: string; readonly exact: boolean };

type Context = {
  readonly checker: ts.TypeChecker;
  readonly segments: readonly MatchSegment[];
  readonly path: string | null;
};

const NAVIGATION_MODULE = 'next/navigation';
const SENTINEL = '\u0000';
const HOLE = '.*';
const MAX_DEPTH = 12;
const PATH_METHODS = new Set(['includes', 'startsWith', 'endsWith']);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function concretePath(segments: readonly MatchSegment[]): string | null {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'static') parts.push(segment.value);
    else if (segment.kind === 'dynamic') parts.push(SENTINEL);
    else return null;
  }
  return `/${parts.join('/')}`;
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

function declarationOf(identifier: ts.Identifier, { checker }: Context): ts.Declaration | undefined {
  return checker.getSymbolAtLocation(identifier)?.declarations?.[0];
}

function isNavigationHook(callee: ts.Expression, hook: string, context: Context): boolean {
  const target = unwrap(callee);
  if (!ts.isIdentifier(target)) return false;
  const declaration = declarationOf(target, context);
  if (declaration === undefined || !ts.isImportSpecifier(declaration)) return false;
  const importDeclaration = declaration.parent.parent.parent;
  return (
    ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
    importDeclaration.moduleSpecifier.text === NAVIGATION_MODULE &&
    (declaration.propertyName ?? declaration.name).text === hook
  );
}

function bindingKey(element: ts.BindingElement): string | undefined {
  if (element.dotDotDotToken !== undefined) return undefined;
  const key = element.propertyName ?? element.name;
  return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
}

function initializerOf(identifier: ts.Identifier, context: Context): ts.Expression | undefined {
  const declaration = declarationOf(identifier, context);
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration)) {
    return declaration.initializer;
  }
  return undefined;
}

function valueOf(expression: ts.Expression, context: Context, depth: number): Value | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', pattern: escape(node.text), exact: true };
  }
  if (ts.isTemplateExpression(node)) {
    const pattern = [escape(node.head.text), ...node.templateSpans.map((span) => HOLE + escape(span.literal.text))];
    return { kind: 'string', pattern: pattern.join(''), exact: false };
  }
  if (ts.isCallExpression(node)) {
    if (isNavigationHook(node.expression, 'usePathname', context)) return { kind: 'pathname' };
    if (isNavigationHook(node.expression, 'useParams', context)) return { kind: 'params' };
    return undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return valueOf(node.expression, context, depth + 1)?.kind === 'params'
      ? { kind: 'param', name: node.name.text }
      : undefined;
  }
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = declarationOf(node, context);
  if (declaration === undefined) return undefined;
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = initializerOf(node, context);
    return initializer === undefined ? undefined : valueOf(initializer, context, depth + 1);
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const owner = declaration.parent.parent;
    const name = bindingKey(declaration);
    if (name === undefined || !ts.isVariableDeclaration(owner) || !isConstDeclaration(owner)) return undefined;
    if (owner.initializer === undefined) return undefined;
    return valueOf(owner.initializer, context, depth + 1)?.kind === 'params' ? { kind: 'param', name } : undefined;
  }
  return undefined;
}

function pathTest(
  method: 'includes' | 'startsWith' | 'endsWith' | 'equals',
  { pattern, exact }: Extract<Value, { kind: 'string' }>,
  context: Context,
): Truth {
  if (context.path === null) return 'unknown';
  const anchored =
    method === 'startsWith' ? `^${pattern}` : method === 'endsWith' ? `${pattern}$` : method === 'equals' ? `^${pattern}$` : pattern;
  if (!new RegExp(anchored).test(context.path)) return 'never';
  return exact ? 'always' : 'unknown';
}

function paramTruth(name: string, { segments }: Context): Truth {
  const segment = segments.find((candidate) => candidate.kind !== 'static' && candidate.name === name);
  if (segment === undefined) return 'never';
  return segment.kind === 'dynamic' || segment.kind === 'catch-all' ? 'always' : 'unknown';
}

const negate = (truth: Truth): Truth => (truth === 'always' ? 'never' : truth === 'never' ? 'always' : 'unknown');

function and(left: Truth, right: Truth): Truth {
  if (left === 'never' || right === 'never') return 'never';
  return left === 'always' && right === 'always' ? 'always' : 'unknown';
}

function or(left: Truth, right: Truth): Truth {
  if (left === 'always' || right === 'always') return 'always';
  return left === 'never' && right === 'never' ? 'never' : 'unknown';
}

function equalityTruth(binary: ts.BinaryExpression, context: Context, depth: number): Truth {
  const kind = binary.operatorToken.kind;
  const equal = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken;
  const left = valueOf(binary.left, context, depth + 1);
  const right = valueOf(binary.right, context, depth + 1);
  const text = left?.kind === 'pathname' ? right : right?.kind === 'pathname' ? left : undefined;
  if (text?.kind !== 'string') return 'unknown';
  const truth = pathTest('equals', text, context);
  return equal ? truth : negate(truth);
}

function truthOf(expression: ts.Expression, context: Context, depth = 0): Truth {
  if (depth > MAX_DEPTH) return 'unknown';
  const node = unwrap(expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return negate(truthOf(node.operand, context, depth + 1));
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return and(truthOf(node.left, context, depth + 1), truthOf(node.right, context, depth + 1));
    }
    if (kind === ts.SyntaxKind.BarBarToken) {
      return or(truthOf(node.left, context, depth + 1), truthOf(node.right, context, depth + 1));
    }
    switch (kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return equalityTruth(node, context, depth);
      default:
        return 'unknown';
    }
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !PATH_METHODS.has(callee.name.text) || node.arguments.length !== 1) {
      return 'unknown';
    }
    const receiver = valueOf(callee.expression, context, depth + 1);
    const argument = valueOf(node.arguments[0]!, context, depth + 1);
    if (receiver?.kind !== 'pathname' || argument?.kind !== 'string') return 'unknown';
    return pathTest(callee.name.text as 'includes' | 'startsWith' | 'endsWith', argument, context);
  }
  const value = valueOf(node, context, depth + 1);
  if (value?.kind === 'param') return paramTruth(value.name, context);
  if (ts.isIdentifier(node)) {
    const initializer = initializerOf(node, context);
    if (initializer !== undefined) return truthOf(initializer, context, depth + 1);
  }
  return 'unknown';
}

function returnsOutsideFunctions(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, returnsOutsideFunctions) === true;
}

const rules = (truth: Truth, runsWhen: boolean): boolean => truth === (runsWhen ? 'never' : 'always');

function guardOf(parent: ts.Node, child: ts.Node): { condition: ts.Expression; runsWhen: boolean } | undefined {
  if (ts.isBinaryExpression(parent) && child === parent.right) {
    if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return { condition: parent.left, runsWhen: true };
    }
    if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return { condition: parent.left, runsWhen: false };
  }
  if (ts.isConditionalExpression(parent) && child !== parent.condition) {
    return { condition: parent.condition, runsWhen: child === parent.whenTrue };
  }
  if (ts.isIfStatement(parent) && child !== parent.expression) {
    return { condition: parent.expression, runsWhen: child === parent.thenStatement };
  }
  return undefined;
}

function isBlocked(node: ts.Node, context: Context): boolean {
  let child = node;
  for (let parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    const guard = guardOf(parent, child);
    if (guard !== undefined && rules(truthOf(guard.condition, context), guard.runsWhen)) return true;
    if (!ts.isBlock(parent)) continue;
    for (const statement of parent.statements) {
      if (statement === child) break;
      if (
        ts.isIfStatement(statement) &&
        returnsOutsideFunctions(statement.thenStatement) &&
        truthOf(statement.expression, context) === 'always'
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createGuardCheck(program: ts.Program): (node: ts.Node, screen: MatchRoute) => boolean {
  const checker = program.getTypeChecker();
  return (node, screen) =>
    !isBlocked(node, { checker, segments: screen.segments, path: concretePath(screen.segments) });
}
