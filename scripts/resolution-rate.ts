import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import ts from 'typescript6';
import { analyze } from '../src/commands/scan.js';
import type { CallClassification, CallOutcome } from '../src/ingest/navigation.js';
import type { NavCall } from '../src/next/nav-calls.js';

type Row = {
  readonly app: string;
  readonly file: string;
  readonly line: number;
  readonly api: string;
  readonly text: string;
  readonly cls: string;
};

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
function callLabel({ contexts }: CallOutcome): { readonly label: string; readonly excluded: boolean } {
  const classifications = contexts.map(({ classification }) => classification);
  const unresolved = classifications.find((c) => c.kind === 'unresolved');
  if (unresolved !== undefined) return { label: label(unresolved), excluded: false };
  const resolved = classifications.some((c) => c.kind === 'resolved');
  if (resolved) return { label: 'resolved', excluded: false };
  const [first] = classifications;
  return { label: first === undefined ? 'resolved' : label(first), excluded: true };
}

function api(call: NavCall): string {
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

function row(app: string, outcome: CallOutcome): Row {
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

function rate(resolved: number, internal: number): string {
  return internal === 0 ? '-' : `${((100 * resolved) / internal).toFixed(1)}%`;
}

const { values, positionals } = parseArgs({
  options: { rows: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});
if (positionals.length === 0) {
  process.stderr.write('usage: tsx scripts/resolution-rate.ts [--rows rows.json] <app-root>...\n');
  process.exit(2);
}

const rows: Row[] = [];
let totalInternal = 0;
let totalResolved = 0;
process.stdout.write('app\tinternal\tresolved\trate\n');
for (const app of positionals) {
  const { outcomes } = await analyze({ path: app, createdAt: new Date() });
  let internal = 0;
  let resolved = 0;
  for (const outcome of outcomes) {
    const { label: cls, excluded } = callLabel(outcome);
    if (!excluded) internal += 1;
    if (cls === 'resolved') resolved += 1;
    rows.push(row(app, outcome));
  }
  totalInternal += internal;
  totalResolved += resolved;
  process.stdout.write(`${app}\t${internal}\t${resolved}\t${rate(resolved, internal)}\n`);
}
process.stdout.write(`total\t${totalInternal}\t${totalResolved}\t${rate(totalResolved, totalInternal)}\n`);
if (values.rows !== undefined) await writeFile(values.rows, `${JSON.stringify(rows, null, 1)}\n`);
