import { join, relative } from 'node:path';
import ts from 'typescript6';
import type { RoutePattern } from '../graph/model.js';
import type { RouteTable } from './routes.js';

const WRAPPER_FILES = ['layout', 'template'].flatMap((name) =>
  ['tsx', 'ts', 'jsx', 'js'].map((extension) => `${name}.${extension}`),
);

// A lazy import stored in an object or array is one entry of a table looked up by a runtime key,
// so the importer renders at most one entry and the table cannot say which.
function isTableEntry(node: ts.Node): boolean {
  for (let current = node; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) return true;
    if (ts.isArrayLiteralExpression(current.parent)) return true;
  }
  return false;
}

type Unit = ts.Statement | ts.SourceFile;

function topLevelStatement(node: ts.Node): ts.Statement | undefined {
  for (let current = node; current.parent !== undefined; current = current.parent) {
    if (ts.isSourceFile(current.parent)) return current as ts.Statement;
  }
  return undefined;
}

function isTypeDeclaration(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

function isEvaluation(statement: ts.Statement): boolean {
  return !(
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement) ||
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    isTypeDeclaration(statement)
  );
}

function isClassExtends(node: ts.Node): node is ts.ExpressionWithTypeArguments {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(node.parent.parent)
  );
}

function referenceGraph({
  program,
  root,
  tracked,
}: {
  program: ts.Program;
  root: string;
  tracked: ReadonlySet<string>;
}): (unit: Unit) => readonly Unit[] {
  const checker = program.getTypeChecker();
  const trackedFiles = new Set(
    program.getSourceFiles().filter((sourceFile) => tracked.has(relative(root, sourceFile.fileName))),
  );

  const moduleAt = (specifier: ts.Expression | undefined): ts.SourceFile | undefined => {
    const target = specifier === undefined ? undefined : checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    return target !== undefined && ts.isSourceFile(target) && trackedFiles.has(target) ? target : undefined;
  };

  const symbolOf = (identifier: ts.Identifier): ts.Symbol | undefined => {
    const parent = identifier.parent;
    if (ts.isShorthandPropertyAssignment(parent)) return checker.getShorthandAssignmentValueSymbol(parent);
    if (ts.isExportSpecifier(parent)) {
      if (parent.isTypeOnly || identifier !== (parent.propertyName ?? parent.name)) return undefined;
      return parent.parent.parent.moduleSpecifier === undefined
        ? checker.getExportSpecifierLocalTargetSymbol(parent)
        : checker.getSymbolAtLocation(identifier);
    }
    if ((parent as { name?: ts.Node }).name === identifier) return undefined;
    if (ts.isBindingElement(parent) && parent.propertyName === identifier) return undefined;
    return checker.getSymbolAtLocation(identifier);
  };

  const statementEdges = (statement: ts.Statement): readonly Unit[] => {
    if (isTypeDeclaration(statement)) return [];
    const edges = new Set<Unit>([statement.getSourceFile()]);
    const reachModule = (sourceFile: ts.SourceFile | undefined) => {
      for (const target of sourceFile?.statements ?? []) edges.add(target);
    };
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) return [...edges];
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return [];
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        reachModule(moduleAt(statement.moduleSpecifier));
        return [...edges];
      }
    }
    const reachSymbol = (symbol: ts.Symbol | undefined) => {
      if (symbol === undefined) return;
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of target.declarations ?? []) {
        if (ts.isSourceFile(declaration)) {
          if (trackedFiles.has(declaration)) reachModule(declaration);
          continue;
        }
        if (!trackedFiles.has(declaration.getSourceFile())) continue;
        const enclosing = topLevelStatement(declaration);
        if (enclosing !== undefined && !isTypeDeclaration(enclosing)) edges.add(enclosing);
      }
    };
    const visit = (node: ts.Node): void => {
      if (isClassExtends(node)) return visit(node.expression);
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) return reachSymbol(symbolOf(node));
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !isTableEntry(node)) {
        reachModule(moduleAt(node.arguments[0]));
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
    edges.delete(statement);
    return [...edges];
  };

  const fileEdges = (sourceFile: ts.SourceFile): readonly Unit[] =>
    sourceFile.statements.flatMap((statement): Unit[] => {
      if (ts.isImportDeclaration(statement)) {
        const target = statement.importClause === undefined ? moduleAt(statement.moduleSpecifier) : undefined;
        return target === undefined ? [] : [target];
      }
      return isEvaluation(statement) ? [statement] : [];
    });

  const memo = new Map<Unit, readonly Unit[]>();
  return (unit) => {
    const cached = memo.get(unit);
    if (cached !== undefined) return cached;
    const edges = ts.isSourceFile(unit) ? fileEdges(unit) : statementEdges(unit);
    memo.set(unit, edges);
    return edges;
  };
}

function wrappersOf(pageFile: string, appDir: string, tracked: ReadonlySet<string>): readonly string[] {
  const directories = pageFile.slice(appDir.length + 1).split('/').slice(0, -1);
  return Array.from({ length: directories.length + 1 }, (_, depth) => join(appDir, ...directories.slice(0, depth)))
    .flatMap((directory) => WRAPPER_FILES.map((name) => `${directory}/${name}`))
    .filter((file) => tracked.has(file));
}

export type ScreensOf = (node: ts.Node) => ReadonlySet<RoutePattern>;

// A screen renders its page and every enclosing layout and template (a redirect-only screen, its
// page alone). Reach then runs over top-level statements: a reached statement reaches the
// statements declaring the names it references, and evaluating a module reaches its side effects.
export function screenReach({
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
}): ScreensOf {
  const tracked = new Set(files);
  const edgesOf = referenceGraph({ program, root, tracked });
  const seeds = new Map<RoutePattern, ts.Statement[]>();
  for (const route of table.routes) {
    if (route.kind !== 'page') continue;
    const wrappers = redirectOnly.has(route.pattern) ? [] : wrappersOf(route.file, table.appDir, tracked);
    const statements = [route.file, ...wrappers].flatMap(
      (file) => program.getSourceFile(join(root, file))?.statements ?? [],
    );
    const existing = seeds.get(route.pattern);
    if (existing === undefined) seeds.set(route.pattern, statements);
    else existing.push(...statements);
  }

  const screens = new Map<ts.Statement, Set<RoutePattern>>();
  for (const [pattern, start] of seeds) {
    const seen = new Set<Unit>();
    const queue: Unit[] = [...start];
    for (let unit = queue.pop(); unit !== undefined; unit = queue.pop()) {
      if (seen.has(unit)) continue;
      seen.add(unit);
      if (!ts.isSourceFile(unit)) {
        const patterns = screens.get(unit);
        if (patterns === undefined) screens.set(unit, new Set([pattern]));
        else patterns.add(pattern);
      }
      queue.push(...edgesOf(unit));
    }
  }
  const none: ReadonlySet<RoutePattern> = new Set();
  return (node) => {
    const statement = topLevelStatement(node);
    return (statement === undefined ? undefined : screens.get(statement)) ?? none;
  };
}
