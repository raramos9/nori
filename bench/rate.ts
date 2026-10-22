import ts from 'typescript6';
import type { CallClassification, CallOutcome } from '../src/ingest/navigation.js';
import type { NavCall } from '../src/next/nav-calls.js';

export type Row = {
  readonly app: string;
  readonly file: string;
  readonly line: number;
  readonly api: string;
  readonly text: string;
  readonly cls: string;
};

export type Tally = { readonly internal: number; readonly resolved: number };

function label(classification: CallClassification): string {
  switch (classification.kind) {
    case 'resolved':
      return 'resolved';
    case 'unresolved':
      return classification.reason;
    case 'excluded':
      return classification.why;
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

// A call counts as resolved only when it resolves in every source context.
export function callLabel({ contexts }: Pick<CallOutcome, 'contexts'>): {
  readonly label: string;
  readonly excluded: boolean;
} {
  const classifications = contexts.map(({ classification }) => classification);
  const unresolved = classifications.find((c) => c.kind === 'unresolved');
  if (unresolved !== undefined) return { label: label(unresolved), excluded: false };
  const resolved = classifications.some((c) => c.kind === 'resolved');
  if (resolved) return { label: 'resolved', excluded: false };
  const [first] = classifications;
  return { label: first === undefined ? 'resolved' : label(first), excluded: true };
}

export function tally(outcomes: readonly Pick<CallOutcome, 'contexts'>[]): Tally {
  let internal = 0;
  let resolved = 0;
  for (const outcome of outcomes) {
    const { label: cls, excluded } = callLabel(outcome);
    if (excluded) continue;
    internal += 1;
    if (cls === 'resolved') resolved += 1;
  }
  return { internal, resolved };
}

export function api(call: NavCall): string {
  switch (call.trigger.kind) {
    case 'link': {
      let node: ts.Node = call.expression;
      while (!ts.isJsxAttribute(node)) node = node.parent;
      return node.parent.parent.tagName.getText() === 'a' ? '<a href>' : '<Link href>';
    }
    case 'router-push':
      return 'router.push';
    case 'router-replace':
      return 'router.replace';
    case 'redirect':
      return 'redirect';
    default: {
      const _exhaustive: never = call.trigger;
      return _exhaustive;
    }
  }
}

export function row(app: string, outcome: CallOutcome): Row {
  const { call } = outcome;
  const sourceFile = call.expression.getSourceFile();
  return {
    app,
    file: call.file,
    line: sourceFile.getLineAndCharacterOfPosition(call.expression.getStart(sourceFile)).line + 1,
    api: api(call),
    text: call.expression.getText(sourceFile).slice(0, 120),
    cls: callLabel(outcome).label,
  };
}
