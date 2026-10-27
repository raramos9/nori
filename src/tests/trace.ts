import { z } from 'zod';
import {
  parseOrigin,
  parsePageUrl,
  type NavigateMethod,
  type Origin,
  type PageUrl,
  type StepCause,
  type TestFailure,
  type TestStep,
  type TraceRejection,
} from '../graph/model.js';
import { cleanText, LIMITS, oneLine } from './limits.js';
import { readZip } from './zip.js';

export const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([10]);

const RUNNER_ENTRY = 'test.trace';
const CONTEXT_ENTRY = /^\d{1,4}-trace\.trace$/;
const TARGET_ATTRIBUTE = '__playwright_target__';

const NAVIGATE_METHODS: readonly NavigateMethod[] = ['goto', 'reload', 'goBack', 'goForward'];

function isNavigateMethod(method: string): method is NavigateMethod {
  return NAVIGATE_METHODS.some((navigate) => navigate === method);
}

const INPUT_METHODS: ReadonlySet<string> = new Set([
  'click',
  'dblclick',
  'tap',
  'fill',
  'press',
  'type',
  'check',
  'uncheck',
  'setChecked',
  'selectOption',
  'setInputFiles',
  'dispatchEvent',
  'dragAndDrop',
  'keyboardPress',
  'keyboardType',
  'keyboardInsertText',
  'mouseClick',
]);
const FAILING_METHODS: ReadonlySet<string> = new Set(['expect', 'pw:api']);

type Target = { readonly tag: string; readonly href: string | null };
export type SnapshotPhase = 'before' | 'action' | 'after';

export type TraceLine =
  | { readonly type: 'context-options'; readonly version: number; readonly baseURL: string | null }
  | {
      readonly type: 'before';
      readonly callId: string;
      readonly parentId: string | null;
      readonly method: string;
      readonly url: string | null;
      readonly selector: string | null;
    }
  | { readonly type: 'after'; readonly callId: string; readonly endTime: number; readonly error: string | null }
  | {
      readonly type: 'frame-snapshot';
      readonly callId: string;
      readonly phase: SnapshotPhase;
      readonly pageId: string;
      readonly isMainFrame: boolean;
      readonly frameUrl: string;
      readonly timestamp: number;
      // Read from the html only for an action snapshot: later snapshots mark other nodes.
      readonly target: Target | null;
    };

export type TraceEntries = {
  readonly runner: readonly TraceLine[];
  readonly contexts: readonly (readonly TraceLine[])[];
};

export type AttemptTrace = { readonly steps: readonly TestStep[]; readonly failures: readonly TestFailure[] };

export type TraceResult =
  | { readonly kind: 'read'; readonly trace: AttemptTrace }
  | { readonly kind: 'rejected'; readonly why: TraceRejection };

const optionalString = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === 'string' ? value : null));

const lineSchemas = {
  'context-options': z
    .object({ version: z.number(), options: z.object({ baseURL: optionalString }).default({ baseURL: null }) })
    .transform(({ version, options }) => ({ type: 'context-options' as const, version, baseURL: options.baseURL })),
  before: z
    .object({
      callId: z.string(),
      parentId: optionalString,
      method: z.string(),
      params: z.object({ url: optionalString, selector: optionalString }).default({ url: null, selector: null }),
    })
    .transform(({ callId, parentId, method, params }) => ({
      type: 'before' as const,
      callId,
      parentId,
      method,
      url: params.url,
      selector: params.selector === null ? null : oneLine(params.selector),
    })),
  after: z
    .object({ callId: z.string(), endTime: z.number(), error: z.object({ message: z.string().default('') }).optional() })
    .transform(({ callId, endTime, error }) => ({
      type: 'after' as const,
      callId,
      endTime,
      error: error === undefined ? null : cleanText(error.message),
    })),
  'frame-snapshot': z
    .object({
      snapshot: z.object({
        callId: z.string(),
        phase: z.enum(['before', 'action', 'after']),
        pageId: z.string(),
        isMainFrame: z.boolean().default(false),
        frameUrl: z.string(),
        timestamp: z.number(),
        html: z.unknown(),
      }),
    })
    .transform(({ snapshot: { html, ...snapshot } }) => ({
      type: 'frame-snapshot' as const,
      ...snapshot,
      target: snapshot.phase === 'action' ? findTarget(html) : null,
    })),
} satisfies Record<TraceLine['type'], z.ZodType<TraceLine, unknown>>;

function isLineType(value: unknown): value is TraceLine['type'] {
  return typeof value === 'string' && Object.hasOwn(lineSchemas, value);
}

const typeSchema = z.object({ type: z.unknown() });
const METHOD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const RUNNER_METHOD = /^(?:pw:api|test\.[A-Za-z]{1,32})$/;

// A snapshot node is [tag, attributes, ...children]; a reference into an earlier snapshot is [[n, m]]
// and a text node is a string, so neither can be the target. Past snapshotNodes the anchor is unknown.
function findTarget(html: unknown): Target | null {
  const pending: unknown[] = [html];
  let queued = 1;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') continue;
    const attributes: unknown = node[1];
    const hasAttributes = typeof attributes === 'object' && attributes !== null && !Array.isArray(attributes);
    if (hasAttributes && Object.hasOwn(attributes, TARGET_ATTRIBUTE)) {
      const href: unknown = Reflect.get(attributes, 'href');
      return { tag: oneLine(node[0]), href: typeof href === 'string' ? href : null };
    }
    queued += node.length;
    if (queued > LIMITS.snapshotNodes) return null;
    for (let child = node.length - 1; child >= (hasAttributes ? 2 : 1); child--) pending.push(node[child]);
  }
  return null;
}

export type ParsedLine = { readonly kind: 'line'; readonly line: TraceLine } | { readonly kind: 'unknown' } | { readonly kind: 'bad' };

export function parseTraceLine(json: unknown): ParsedLine {
  const head = typeSchema.safeParse(json);
  if (!head.success) return { kind: 'bad' };
  if (!isLineType(head.data.type)) return { kind: 'unknown' };
  const result = lineSchemas[head.data.type].safeParse(json);
  if (!result.success) return { kind: 'bad' };
  const line = result.data;
  if (line.type === 'before' && !METHOD.test(line.method) && !RUNNER_METHOD.test(line.method)) return { kind: 'unknown' };
  return { kind: 'line', line };
}

type Push = (line: TraceLine) => TraceRejection | null;

// Each line goes straight to the walk, so nothing of an entry is kept but the walk's own capped state.
// A killed worker leaves a torn last line, so a bad line is held until a later non-empty line shows it
// was not the last. Every line, blank or not, counts against the one budget the whole trace shares.
function parseLines(entry: string, bytes: Buffer, budget: { lines: number }, push: Push): TraceRejection | null {
  let bad: number | null = null;
  for (let start = 0, index = 0; start <= bytes.length; index++) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    budget.lines += 1;
    if (budget.lines > LIMITS.linesPerTrace) return { kind: 'too-many-lines', entry, count: budget.lines };
    const text = bytes.toString('utf8', start, end);
    start = end + 1;
    if (text.trim() === '') continue;
    if (bad !== null) return { kind: 'bad-trace-line', entry, line: bad };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = parseTraceLine(json);
    if (parsed.kind === 'bad') bad = index + 1;
    if (parsed.kind !== 'line') continue;
    const { line } = parsed;
    if (line.type === 'context-options' && !SUPPORTED_VERSIONS.has(line.version)) {
      return { kind: 'unsupported-trace-version', version: line.version };
    }
    const rejected = push(line);
    if (rejected !== null) return rejected;
  }
  return null;
}

export async function readTrace(file: string): Promise<TraceResult> {
  const walk = createWalk();
  const budget = { lines: 0 };
  let entries = 0;
  const read = await readZip({
    file,
    select: (name) => name === RUNNER_ENTRY || CONTEXT_ENTRY.test(name),
    visit: (name, bytes) => {
      entries += 1;
      return parseLines(name, bytes, budget, name === RUNNER_ENTRY ? walk.runner : walk.context());
    },
  });
  if (read.kind === 'rejected') return read;
  if (entries === 0) return { kind: 'rejected', why: { kind: 'no-trace-entries' } };
  return walk.finish();
}

type Call = {
  readonly order: number;
  readonly method: string;
  readonly url: string | null;
  readonly selector: string | null;
  end: number;
  page: string | null;
  target: Target | null;
};

type Draft = {
  readonly pageId: string;
  at: number;
  readonly origin: Origin;
  readonly cause: StepCause;
  readonly causeOrder: number | null;
  readonly from: string | null;
  readonly chain: [string, ...string[]];
};

// navigate and input hold the orders of the page's qualifying calls, ascending.
type PageState = {
  current: string | null;
  after: number;
  last: Draft | null;
  readonly navigate: number[];
  readonly input: number[];
};

// stepCount counts redirect hops too, so a chain cannot grow past the step budget.
type Attempt = { readonly calls: Map<string, Call>; readonly drafts: Draft[]; callCount: number; stepCount: number };

// An http(s) URL without its fragment, or null. Past urlChars a URL is noise nothing needs to keep.
function documentUrl(raw: string, base?: string): string | null {
  if (raw.length > LIMITS.urlChars) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href.length > LIMITS.urlChars ? null : url.href;
}

function originOf(raw: string | null): Origin | null {
  if (raw === null) return null;
  try {
    return parseOrigin(raw);
  } catch {
    return null;
  }
}

function onOrigin(origin: Origin, raw: string): PageUrl | null {
  try {
    return parsePageUrl(origin, raw);
  } catch {
    return null;
  }
}

function causeOf(call: Call, origin: Origin): StepCause {
  if (isNavigateMethod(call.method)) {
    const requested = call.method === 'goto' && call.url !== null ? documentUrl(call.url, origin) : null;
    return { kind: 'navigate', method: call.method, requested };
  }
  const { target } = call;
  const href = target !== null && target.tag.toUpperCase() === 'A' ? target.href : null;
  const anchor = href === null ? null : onOrigin(origin, href);
  return { kind: 'input', method: call.method, selector: call.selector, anchor };
}

function lastAtOrBefore(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Infinity) <= limit) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

const latest = (orders: readonly number[], through: number): number => orders[lastAtOrBefore(orders, through)] ?? -1;

// The most recent navigation method in the window wins; otherwise its most recent input method.
function windowCause(page: PageState, through: number): number | null {
  const navigate = latest(page.navigate, through);
  if (navigate > page.after) return navigate;
  const input = latest(page.input, through);
  return input > page.after ? input : null;
}

function assignPage(call: Call, page: PageState): void {
  const orders = isNavigateMethod(call.method) ? page.navigate : INPUT_METHODS.has(call.method) ? page.input : null;
  // Calls on one page run one after another, so a call whose first snapshot arrives after a later call's
  // is left out of the windows rather than breaking their order.
  if (orders !== null && call.order > (orders[orders.length - 1] ?? -1)) orders.push(call.order);
}

// A URL is first seen in some call's snapshot, often a later call's (a soft navigation shows up in the
// next expect). A before snapshot means the cause ran strictly earlier; action or after means up to and
// including that call. The window opens after the call that produced the page's previous URL.
function contextWalk(attempt: Attempt): Push {
  const ordered: Call[] = [];
  const pages = new Map<string, PageState>();
  const pageOf = (pageId: string): PageState => {
    const found = pages.get(pageId);
    if (found !== undefined) return found;
    const page: PageState = { current: null, after: -1, last: null, navigate: [], input: [] };
    pages.set(pageId, page);
    return page;
  };
  let origin: Origin | null = null;
  return (line) => {
    switch (line.type) {
      case 'context-options':
        origin ??= originOf(line.baseURL);
        break;
      case 'before': {
        attempt.callCount += 1;
        if (attempt.callCount > LIMITS.callsPerAttempt) return { kind: 'too-many-calls', count: attempt.callCount };
        const call: Call = { order: ordered.length, method: line.method, url: line.url, selector: line.selector, end: -Infinity, page: null, target: null };
        ordered.push(call);
        attempt.calls.set(line.callId, call);
        break;
      }
      case 'after': {
        const call = attempt.calls.get(line.callId);
        if (call !== undefined) call.end = Math.max(call.end, line.endTime);
        break;
      }
      case 'frame-snapshot': {
        const call = attempt.calls.get(line.callId);
        if (call !== undefined) {
          if (call.page === null) {
            call.page = line.pageId;
            assignPage(call, pageOf(line.pageId));
          }
          call.end = Math.max(call.end, line.timestamp);
          // The marked frame names the target; another frame's action snapshot of the same call never
          // replaces it. The href resolves against that frame's URL, as the browser resolved it.
          if (line.phase === 'action' && call.target === null && line.target !== null) {
            const { tag, href } = line.target;
            call.target = { tag, href: href === null ? null : documentUrl(href, documentUrl(line.frameUrl) ?? undefined) };
          }
        }
        const url = line.isMainFrame ? documentUrl(line.frameUrl) : null;
        if (url === null) break;
        origin ??= originOf(url);
        if (origin === null) break;
        const page = pageOf(line.pageId);
        if (url === page.current) break;
        const through = call === undefined ? ordered.length - 1 : line.phase === 'before' ? call.order - 1 : call.order;
        const causeOrder = windowCause(page, through);
        const { last } = page;
        const latestQualifying = Math.max(latest(page.navigate, through), latest(page.input, through));
        attempt.stepCount += 1;
        if (attempt.stepCount > LIMITS.stepsPerAttempt) return { kind: 'too-many-steps', count: attempt.stepCount };
        if (causeOrder === null && last !== null && last.causeOrder !== null && latestQualifying === last.causeOrder) {
          last.chain.push(url);
          last.at = line.timestamp;
          page.current = url;
          break;
        }
        const cause = causeOrder === null ? undefined : ordered[causeOrder];
        const draft: Draft = {
          pageId: line.pageId,
          at: line.timestamp,
          origin,
          cause: cause === undefined ? { kind: 'none' } : causeOf(cause, origin),
          causeOrder,
          from: page.current,
          chain: [url],
        };
        attempt.drafts.push(draft);
        page.current = url;
        page.after = causeOrder ?? through;
        page.last = draft;
        break;
      }
      default: {
        const _exhaustive: never = line;
        return _exhaustive;
      }
    }
    return null;
  };
}

type RunnerCall = { readonly callId: string; readonly method: string; readonly parentId: string | null; end: number; error: string | null };

type Walk = { readonly context: () => Push; readonly runner: Push; readonly finish: () => TraceResult };

function createWalk(): Walk {
  const attempt: Attempt = { calls: new Map(), drafts: [], callCount: 0, stepCount: 0 };
  const runnerCalls = new Map<string, RunnerCall>();
  const runner: Push = (line) => {
    if (line.type === 'before') {
      runnerCalls.set(line.callId, { callId: line.callId, method: line.method, parentId: line.parentId, end: -Infinity, error: null });
      if (runnerCalls.size > LIMITS.callsPerAttempt) return { kind: 'too-many-calls', count: runnerCalls.size };
    }
    if (line.type === 'after') {
      const call = runnerCalls.get(line.callId);
      if (call !== undefined) {
        call.end = Math.max(call.end, line.endTime);
        call.error ??= line.error;
      }
    }
    return null;
  };
  return { context: () => contextWalk(attempt), runner, finish: () => finish(attempt, runnerCalls) };
}

function leaves(calls: ReadonlyMap<string, RunnerCall>): readonly RunnerCall[] {
  const parents = new Set([...calls.values()].flatMap(({ parentId }) => (parentId === null ? [] : [parentId])));
  return [...calls.values()].filter(({ callId }) => !parents.has(callId));
}

// The per-page URL timeline and call windows of one attempt, then each passing expect counted on the
// step its page was on when it settled, and each failing leaf call located the same way.
function finish(attempt: Attempt, runnerCalls: ReadonlyMap<string, RunnerCall>): TraceResult {
  const drafts = attempt.drafts.toSorted((a, b) => a.at - b.at);

  const times = drafts.map(({ at }) => at);
  const byPage = new Map<string, { readonly times: number[]; readonly indices: number[] }>();
  drafts.forEach(({ pageId, at }, index) => {
    const page = byPage.get(pageId) ?? { times: [], indices: [] };
    byPage.set(pageId, page);
    page.times.push(at);
    page.indices.push(index);
  });
  const stepAt = (callId: string, runnerEnd: number): number | null => {
    const call = attempt.calls.get(callId);
    const settled = Math.max(runnerEnd, call?.end ?? -Infinity);
    const pageId = call?.page ?? null;
    if (pageId === null) {
      const index = lastAtOrBefore(times, settled);
      return index === -1 ? null : index;
    }
    const page = byPage.get(pageId);
    return page === undefined ? null : (page.indices[lastAtOrBefore(page.times, settled)] ?? null);
  };

  const assertions = drafts.map(() => 0);
  const failures: TestFailure[] = [];
  for (const call of leaves(runnerCalls)) {
    if (call.error !== null && FAILING_METHODS.has(call.method)) {
      failures.push({ message: call.error, step: stepAt(call.callId, call.end) });
      if (failures.length > LIMITS.failuresPerAttempt) return { kind: 'rejected', why: { kind: 'too-many-failures', count: failures.length } };
    } else if (call.error === null && call.method === 'expect') {
      const step = stepAt(call.callId, call.end);
      if (step !== null) assertions[step] = (assertions[step] ?? 0) + 1;
    }
  }

  const pageIndex = new Map<string, number>();
  const steps = drafts.map(({ pageId, at, origin, cause, from, chain }, seq): TestStep => {
    const page = pageIndex.get(pageId) ?? pageIndex.size;
    pageIndex.set(pageId, page);
    return { seq, page, at, origin, cause, from, chain, assertions: assertions[seq] ?? 0 };
  });
  return { kind: 'read', trace: { steps, failures } };
}

// Pure: the walk readTrace runs while it parses, over already-parsed lines.
export function stepsOf({ runner, contexts }: TraceEntries): TraceResult {
  const walk = createWalk();
  for (const line of runner) {
    const rejected = walk.runner(line);
    if (rejected !== null) return { kind: 'rejected', why: rejected };
  }
  for (const lines of contexts) {
    const push = walk.context();
    for (const line of lines) {
      const rejected = push(line);
      if (rejected !== null) return { kind: 'rejected', why: rejected };
    }
  }
  return walk.finish();
}
