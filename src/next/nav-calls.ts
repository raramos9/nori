import ts from 'typescript6';
import type { SourceSpan, Trigger } from '../graph/model.js';

export const NAV_EXTRACTOR = 'next-nav-ts';

export type NavCall = {
  readonly trigger: Trigger;
  readonly expression: ts.Expression;
  readonly span: SourceSpan;
  readonly file: string;
};

const ROUTER_TRIGGERS: ReadonlyMap<string, Trigger> = new Map([
  ['push', { kind: 'router-push' }],
  ['replace', { kind: 'router-replace' }],
]);
const REDIRECTS: ReadonlySet<string> = new Set(['redirect', 'permanentRedirect']);
const LINK: Trigger = { kind: 'link' };
const REDIRECT: Trigger = { kind: 'redirect' };

function spanOf(sourceFile: ts.SourceFile, node: ts.Node, file: string): SourceSpan {
  const position = (offset: number) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: character + 1 };
  };
  return { file, start: position(node.getStart(sourceFile)), end: position(node.getEnd()) };
}

function hrefExpression(attribute: ts.JsxAttribute): ts.Expression | undefined {
  const { initializer } = attribute;
  if (initializer === undefined) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer;
  return ts.isJsxExpression(initializer) ? initializer.expression : undefined;
}

function linkTarget(node: ts.JsxAttribute, sourceFile: ts.SourceFile): ts.Expression | undefined {
  if (node.name.getText(sourceFile) !== 'href') return undefined;
  const tag = node.parent.parent.tagName.getText(sourceFile);
  if (tag !== 'a' && !tag.endsWith('Link')) return undefined;
  return hrefExpression(node);
}

export function callTrigger(node: ts.CallExpression, sourceFile: ts.SourceFile): Trigger | null {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && /router/i.test(callee.expression.getText(sourceFile))) {
    return ROUTER_TRIGGERS.get(callee.name.text) ?? null;
  }
  if (ts.isIdentifier(callee) && REDIRECTS.has(callee.text)) return REDIRECT;
  return null;
}

export function findNavCalls(sourceFile: ts.SourceFile, file: string): readonly NavCall[] {
  const calls: NavCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const expression = linkTarget(node, sourceFile);
      if (expression !== undefined) {
        calls.push({ trigger: LINK, expression, span: spanOf(sourceFile, node, file), file });
      }
    } else if (ts.isCallExpression(node)) {
      const [expression] = node.arguments;
      const trigger = expression === undefined ? null : callTrigger(node, sourceFile);
      if (expression !== undefined && trigger !== null) {
        calls.push({ trigger, expression, span: spanOf(sourceFile, node, file), file });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}
