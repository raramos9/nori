import { join, relative } from 'node:path';
import ts from 'typescript6';
import type { RoutePattern } from '../graph/model.js';
import type { RouteTable } from './routes.js';

const WRAPPER_FILES = ['layout', 'template'].flatMap((name) =>
  ['tsx', 'ts', 'jsx', 'js'].map((extension) => `${name}.${extension}`),
);

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

// A lazy import stored in an object or array is one entry of a table looked up by a runtime key,
// so the importer renders at most one entry and the table cannot say which.
function isTableEntry(node: ts.Node): boolean {
  for (let current = node; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) return true;
    if (ts.isArrayLiteralExpression(current.parent)) return true;
  }
  return false;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): readonly ts.Expression[] {
  const specifiers: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) specifiers.push(node.moduleSpecifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && !isTypeOnlyExport(node)) specifiers.push(node.moduleSpecifier);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && !isTableEntry(node)) specifiers.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function importGraph({
  program,
  root,
  tracked,
}: {
  program: ts.Program;
  root: string;
  tracked: ReadonlySet<string>;
}): ReadonlyMap<string, readonly string[]> {
  const checker = program.getTypeChecker();
  const graph = new Map<string, string[]>();
  for (const sourceFile of program.getSourceFiles()) {
    const from = relative(root, sourceFile.fileName);
    if (!tracked.has(from)) continue;
    const imports: string[] = [];
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const target = checker.getSymbolAtLocation(specifier)?.valueDeclaration;
      if (target === undefined || !ts.isSourceFile(target)) continue;
      const to = relative(root, target.fileName);
      if (tracked.has(to)) imports.push(to);
    }
    graph.set(from, imports);
  }
  return graph;
}

function wrappersOf(pageFile: string, appDir: string, tracked: ReadonlySet<string>): readonly string[] {
  const directories = pageFile.slice(appDir.length + 1).split('/').slice(0, -1);
  return Array.from({ length: directories.length + 1 }, (_, depth) => join(appDir, ...directories.slice(0, depth)))
    .flatMap((directory) => WRAPPER_FILES.map((name) => `${directory}/${name}`))
    .filter((file) => tracked.has(file));
}

// A screen renders its page, every enclosing layout and template, and whatever those import.
// A redirect-only screen never renders its wrappers, so it is seeded from its page files alone.
export function screensByFile({
  program,
  root,
  table,
  files,
  redirectOnly,
}: {
  program: ts.Program;
  root: string;
  table: RouteTable;
  files: readonly string[];
  redirectOnly: ReadonlySet<RoutePattern>;
}): ReadonlyMap<string, ReadonlySet<RoutePattern>> {
  const tracked = new Set(files);
  const graph = importGraph({ program, root, tracked });
  const seeds = new Map<RoutePattern, string[]>();
  for (const route of table.routes) {
    if (route.kind !== 'page') continue;
    const wrappers = redirectOnly.has(route.pattern) ? [] : wrappersOf(route.file, table.appDir, tracked);
    const files = [route.file, ...wrappers];
    const existing = seeds.get(route.pattern);
    if (existing === undefined) seeds.set(route.pattern, files);
    else existing.push(...files);
  }

  const screens = new Map<string, Set<RoutePattern>>();
  for (const [pattern, start] of seeds) {
    const seen = new Set<string>();
    const queue = [...start];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      const patterns = screens.get(file);
      if (patterns === undefined) screens.set(file, new Set([pattern]));
      else patterns.add(pattern);
      queue.push(...(graph.get(file) ?? []));
    }
  }
  return screens;
}
