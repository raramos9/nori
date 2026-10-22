import { join } from 'node:path';
import ts from 'typescript6';
import type { RoutePattern } from '../graph/model.js';
import { REDIRECTS } from './nav-calls.js';
import type { RouteTable } from './routes.js';

type PageFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
}

function pageFunctionOf(declaration: ts.Declaration): PageFunction | undefined {
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  const value = ts.isVariableDeclaration(declaration)
    ? declaration.initializer
    : ts.isExportAssignment(declaration)
      ? declaration.expression
      : undefined;
  if (value === undefined) return undefined;
  const expression = unwrap(value);
  return ts.isFunctionExpression(expression) || ts.isArrowFunction(expression) ? expression : undefined;
}

function defaultExport(checker: ts.TypeChecker, sourceFile: ts.SourceFile): PageFunction | undefined {
  const module = checker.getSymbolAtLocation(sourceFile);
  const exported = module === undefined ? undefined : checker.tryGetMemberInModuleExports('default', module);
  if (exported === undefined) return undefined;
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return (symbol.declarations ?? []).map(pageFunctionOf).find((page) => page !== undefined);
}

function isRedirectCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && REDIRECTS.has(node.expression.text);
}

function returnsNothingElse(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return true;
  const outer = unwrap(expression);
  const e = ts.isAwaitExpression(outer) ? unwrap(outer.expression) : outer;
  return isRedirectCall(e) || e.kind === ts.SyntaxKind.NullKeyword;
}

function onlyRedirects(page: PageFunction): boolean {
  const body = page.body;
  if (body === undefined) return false;
  if (!ts.isBlock(body) && !returnsNothingElse(body)) return false;
  let redirects = false;
  let rendersOther = false;
  const visit = (node: ts.Node, inPage: boolean) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) rendersOther = true;
    else if (isRedirectCall(node)) redirects = true;
    else if (inPage && ts.isReturnStatement(node) && !returnsNothingElse(node.expression)) rendersOther = true;
    if (!rendersOther) ts.forEachChild(node, (child) => visit(child, inPage && !ts.isFunctionLike(child)));
  };
  visit(body, true);
  return redirects && !rendersOther;
}

// A page whose component only redirects never shows its layouts; the user lands on its destination.
export function redirectOnlyPages({
  program,
  root,
  table,
}: {
  program: ts.Program;
  root: string;
  table: RouteTable;
}): ReadonlySet<RoutePattern> {
  const checker = program.getTypeChecker();
  const everyFileRedirects = new Map<RoutePattern, boolean>();
  for (const route of table.routes) {
    if (route.kind !== 'page') continue;
    const sourceFile = program.getSourceFile(join(root, route.file));
    const page = sourceFile === undefined ? undefined : defaultExport(checker, sourceFile);
    const redirects = page !== undefined && onlyRedirects(page);
    everyFileRedirects.set(route.pattern, (everyFileRedirects.get(route.pattern) ?? true) && redirects);
  }
  return new Set([...everyFileRedirects].filter(([, redirects]) => redirects).map(([pattern]) => pattern));
}
