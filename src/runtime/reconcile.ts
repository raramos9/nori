import { evidenceId, runId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  type CaptureEvidence,
  type EvidenceId,
  type IgnoreReason,
  type NavigationEvidence,
  type NavigationEvidenceStart,
  type NonEmpty,
  type NotAScreen,
  type PageUrl,
  type RoutePattern,
  type Run,
  type RunIngestion,
  type RuntimeOnlyTransition,
  type ScreenMatch,
  type SkippedHop,
  type StateId,
  type StaticIngestion,
  type StepOutcome,
  type TargetSearch,
  type TransitionId,
  type TransitionMatch,
  type Trigger,
} from '../graph/model.js';
import { resolveUrl, type Matcher, type UrlResolution } from '../next/match.js';
import type { CaptureKey, Redirect, RuntimeAction } from './crawl-result.js';
import { artifactPath } from './layout.js';
import type { SealedCrawlV1 } from './sealed-run.js';

export type StaticSide = {
  readonly ingestion: StaticIngestion;
  readonly matcher: Matcher;
  readonly passThrough: ReadonlySet<RoutePattern>;
};

export function triggerCandidates(action: RuntimeAction): NonEmpty<Trigger['kind']> {
  switch (action.kind) {
    case 'follow-link':
      return ['link'];
    case 'interact':
      return ['router-push', 'router-replace'];
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

type ParsedStart =
  | { readonly kind: 'entry' }
  | { readonly kind: 'action'; readonly from: CaptureEvidence; readonly action: RuntimeAction };

type ParsedNavigation = {
  readonly seq: number;
  readonly start: ParsedStart;
  readonly requested: PageUrl;
  readonly redirects: readonly Redirect[];
  readonly chain: NonEmpty<PageUrl>;
  readonly landing:
    | { readonly kind: 'captured'; readonly capture: CaptureEvidence }
    | { readonly kind: 'aborted'; readonly error: string };
};

export type ValidatedRun = {
  readonly run: Run;
  readonly captures: readonly CaptureEvidence[];
  readonly navigations: readonly ParsedNavigation[];
};

function crawlerBug(message: string): Error {
  return new Error(`Crawl result rejected: ${message}`);
}

export function validateCrawl(sealed: SealedCrawlV1, runDirectory: string): ValidatedRun {
  const { crawl, snapshotId } = sealed;
  const id = runId({ snapshotId, origin: crawl.origin, session: crawl.session, startedAt: crawl.startedAt });
  const onOrigin = (url: PageUrl): PageUrl => {
    if (new URL(url).origin !== crawl.origin) throw crawlerBug(`${url} is not on ${crawl.origin}`);
    return url;
  };

  const byKey = new Map<CaptureKey, CaptureEvidence>();
  const urls = new Set<PageUrl>();
  for (const capture of crawl.captures) {
    if (byKey.has(capture.key)) throw crawlerBug(`capture key ${capture.key} is listed twice`);
    if (urls.has(capture.url)) throw crawlerBug(`${capture.url} is captured twice`);
    if (!Number.isInteger(capture.httpStatus) || capture.httpStatus < 200 || capture.httpStatus > 599) {
      throw crawlerBug(`capture ${capture.key} has HTTP status ${capture.httpStatus}`);
    }
    urls.add(capture.url);
    const identity = { kind: 'capture', runId: id, url: onOrigin(capture.url) } as const;
    byKey.set(capture.key, {
      ...identity,
      id: evidenceId(identity),
      httpStatus: capture.httpStatus,
      screenshot: artifactPath(runDirectory, capture.screenshot),
      dom: artifactPath(runDirectory, capture.dom),
    });
  }
  const captureOf = (key: CaptureKey, seq: number): CaptureEvidence => {
    const capture = byKey.get(key);
    if (capture === undefined) throw crawlerBug(`navigation ${seq} names capture ${key}, which is not listed`);
    return capture;
  };

  const seqs = new Set<number>();
  const navigations = [...crawl.navigations]
    .sort((a, b) => a.seq - b.seq)
    .map((navigation): ParsedNavigation => {
      const { seq, requested, redirects } = navigation;
      if (seqs.has(seq)) throw crawlerBug(`navigation seq ${seq} is listed twice`);
      seqs.add(seq);
      const chain: NonEmpty<PageUrl> = [
        onOrigin(requested),
        ...redirects.map((redirect) => onOrigin(redirect.to)),
      ];
      const start: ParsedStart =
        navigation.start.kind === 'entry'
          ? navigation.start
          : { kind: 'action', from: captureOf(navigation.start.from, seq), action: navigation.start.action };
      if (navigation.landing.kind === 'aborted') {
        return { seq, start, requested, redirects, chain, landing: navigation.landing };
      }
      const capture = captureOf(navigation.landing.capture, seq);
      if (capture.url !== chain[chain.length - 1]) {
        throw crawlerBug(`navigation ${seq} lands on ${capture.url}, but its chain ends at ${chain[chain.length - 1]}`);
      }
      return { seq, start, requested, redirects, chain, landing: { kind: 'captured', capture } };
    });

  const run: Run = {
    id,
    snapshotId,
    origin: crawl.origin,
    session: crawl.session,
    environment: sealed.environment,
    seededBy: sealed.seededBy,
    startedAt: crawl.startedAt,
    finishedAt: crawl.finishedAt,
    stop: crawl.stop,
    crawlerVersion: crawl.crawlerVersion,
    requests: crawl.requests,
  };
  return { run, captures: [...byKey.values()], navigations };
}

type Target =
  | {
      readonly kind: 'target';
      readonly url: PageUrl;
      readonly pattern: RoutePattern;
      readonly skipped: readonly SkippedHop[];
    }
  | { readonly kind: 'not-a-screen'; readonly url: PageUrl; readonly why: NotAScreen };

export type ClientStep = {
  readonly from: PageUrl;
  readonly chain: NonEmpty<PageUrl>;
  readonly triggers: NonEmpty<Trigger['kind']>;
};

// What the static side says about one client navigation. There are no status checks and nothing is
// created here; those are each caller's policy. runtime-only names the transition one trigger would mint.
export type ClientStepMatch =
  | { readonly kind: 'not-a-screen'; readonly end: 'source' | 'target'; readonly url: PageUrl; readonly why: NotAScreen }
  | { readonly kind: 'matched'; readonly transitionId: TransitionId; readonly search: TargetSearch }
  | { readonly kind: 'ambiguous'; readonly candidates: NonEmpty<TransitionId>; readonly search: TargetSearch }
  | { readonly kind: 'runtime-only'; readonly transition: RuntimeOnlyTransition; readonly search: TargetSearch }
  | { readonly kind: 'unknown-trigger'; readonly search: TargetSearch };

export type Reconciler = { readonly matchClientStep: (step: ClientStep) => ClientStepMatch };

const byId = <T extends { readonly id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function reconciler(staticSide: StaticSide) {
  const { ingestion, matcher, passThrough } = staticSide;
  const resolutions = new Map<PageUrl, UrlResolution>();
  const resolve = (url: PageUrl): UrlResolution => {
    let resolution = resolutions.get(url);
    if (resolution === undefined) {
      resolution = resolveUrl({ matcher, url });
      resolutions.set(url, resolution);
    }
    return resolution;
  };

  // State clustering replaces only this: every screen has its default state today.
  const stateOf = (pattern: RoutePattern): StateId =>
    stateId({
      screenId: screenId({ appKey: ingestion.application.id, routePattern: pattern }),
      key: DEFAULT_STATE_KEY,
    });
  const tripleKey = (source: StateId, trigger: Trigger['kind'], target: StateId) => `${source}|${trigger}|${target}`;
  const staticTransitions = new Map<string, TransitionId>();
  for (const transition of ingestion.transitions) {
    if (transition.target.kind !== 'resolved') continue;
    staticTransitions.set(
      tripleKey(transition.sourceStateId, transition.trigger.kind, transition.target.stateId),
      transition.id,
    );
  }

  // The runtime mirror of static landingsOf: a link to a redirect-only page is a link to where it lands.
  const targetOf = (chain: NonEmpty<PageUrl>, from: number): Target => {
    const skipped: SkippedHop[] = [];
    const last = chain.length - 1;
    for (let hop = from; hop <= last; hop++) {
      const url = chain[hop];
      if (url === undefined) break;
      const resolution = resolve(url);
      if (resolution.kind === 'screen' && (hop === last || !passThrough.has(resolution.pattern))) {
        return { kind: 'target', url, pattern: resolution.pattern, skipped };
      }
      if (resolution.kind === 'not-a-screen' && hop === last) return { kind: 'not-a-screen', url, why: resolution.why };
      skipped.push({ url, why: resolution.kind === 'screen' ? 'pass-through' : resolution.why });
    }
    throw new Error('a chain always ends at its landing');
  };

  const staticMatch = (source: RoutePattern, triggers: NonEmpty<Trigger['kind']>, target: RoutePattern) =>
    triggers.flatMap((trigger) => {
      const id = staticTransitions.get(tripleKey(stateOf(source), trigger, stateOf(target)));
      return id === undefined ? [] : [id];
    });

  const matchClientStep = ({ from, chain, triggers }: ClientStep): ClientStepMatch => {
    const source = resolve(from);
    if (source.kind === 'not-a-screen') return { kind: 'not-a-screen', end: 'source', url: from, why: source.why };
    const target = targetOf(chain, 0);
    if (target.kind === 'not-a-screen') return { kind: 'not-a-screen', end: 'target', url: target.url, why: target.why };
    const search: TargetSearch = {
      sourceUrl: from,
      sourcePattern: source.pattern,
      targetUrl: target.url,
      targetPattern: target.pattern,
      skipped: target.skipped,
      triggerCandidates: triggers,
    };
    const [first, ...others] = staticMatch(source.pattern, triggers, target.pattern);
    if (first !== undefined && others.length === 0) return { kind: 'matched', transitionId: first, search };
    if (first !== undefined) return { kind: 'ambiguous', candidates: [first, ...others], search };
    const [trigger, ...otherTriggers] = triggers;
    if (otherTriggers.length > 0) return { kind: 'unknown-trigger', search };
    const sourceStateId = stateOf(source.pattern);
    const transitionTarget = { kind: 'resolved', stateId: stateOf(target.pattern) } as const;
    const id = transitionId({ sourceStateId, trigger: { kind: trigger }, target: transitionTarget });
    return {
      kind: 'runtime-only',
      transition: { id, sourceStateId, trigger: { kind: trigger }, target: transitionTarget },
      search,
    };
  };

  return { resolve, targetOf, staticMatch, matchClientStep };
}

export function createReconciler(staticSide: StaticSide): Reconciler {
  const { matchClientStep } = reconciler(staticSide);
  return { matchClientStep };
}

type Matched = { readonly transitionId: TransitionId; readonly match: TransitionMatch };

type Step =
  | { readonly outcome: StepOutcome }
  | { readonly outcome: StepOutcome; readonly matched: Matched; readonly created?: RuntimeOnlyTransition };

function ignored(step: StepOutcome['step'], reason: IgnoreReason): Step {
  return { outcome: { step, kind: 'ignored', reason } };
}

export function reconcileRun({ staticSide, validated }: { staticSide: StaticSide; validated: ValidatedRun }): RunIngestion {
  const { snapshot, analysis, application } = staticSide.ingestion;
  if (validated.run.snapshotId !== snapshot.id) {
    throw new Error(`Run ${validated.run.id} belongs to snapshot ${validated.run.snapshotId}, not ${snapshot.id}`);
  }
  const { resolve, targetOf, staticMatch, matchClientStep } = reconciler(staticSide);
  const report: StepOutcome[] = [];

  const captures = [...validated.captures].sort(byId).map((evidence) => {
    const step = { kind: 'capture', evidenceId: evidence.id } as const;
    const resolution = resolve(evidence.url);
    if (resolution.kind === 'not-a-screen') {
      report.push({ step, kind: 'ignored', reason: { kind: 'not-a-screen', url: evidence.url, why: resolution.why } });
      return { evidence, match: null };
    }
    const { pattern } = resolution;
    const subject = screenId({ appKey: application.id, routePattern: pattern });
    if (evidence.httpStatus < 400) {
      report.push({ step, kind: 'supports', subject });
      const match: ScreenMatch = { verdict: 'supports', rule: 'rendered', url: evidence.url, pattern };
      return { evidence, match };
    }
    if (evidence.httpStatus < 500) {
      report.push({
        step,
        kind: 'ignored',
        reason: { kind: 'client-error', url: evidence.url, httpStatus: evidence.httpStatus },
      });
      return { evidence, match: null };
    }
    report.push({ step, kind: 'contradicts', subject });
    const match: ScreenMatch = {
      verdict: 'contradicts',
      rule: 'server-error',
      url: evidence.url,
      pattern,
      httpStatus: evidence.httpStatus,
    };
    return { evidence, match };
  });

  const navigations = new Map<EvidenceId, { evidence: NavigationEvidence; matches: Map<TransitionId, Matched> }>();
  const created = new Map<TransitionId, RuntimeOnlyTransition>();

  for (const navigation of validated.navigations) {
    const { seq, chain, landing } = navigation;
    if (landing.kind === 'aborted') {
      report.push({ step: { kind: 'aborted', seq }, kind: 'ignored', reason: { kind: 'aborted', error: landing.error } });
      continue;
    }
    const L = landing.capture;
    const steps: Step[] = [];

    if (navigation.start.kind === 'action') {
      const step = { kind: 'action', seq } as const;
      const { from: S, action } = navigation.start;
      const client = matchClientStep({ from: S.url, chain, triggers: triggerCandidates(action) });
      if (client.kind === 'not-a-screen' && client.end === 'source') {
        steps.push(ignored(step, { kind: 'not-a-screen', url: client.url, why: client.why }));
      } else if (S.httpStatus >= 400) {
        steps.push(ignored(step, { kind: 'source-not-rendered', url: S.url, httpStatus: S.httpStatus }));
      } else if (L.httpStatus >= 400) {
        steps.push(ignored(step, { kind: 'landing-error', url: L.url, httpStatus: L.httpStatus }));
      } else if (client.kind === 'not-a-screen') {
        steps.push(ignored(step, { kind: 'not-a-screen', url: client.url, why: client.why }));
      } else if (client.kind === 'matched') {
        steps.push({
          outcome: { step, kind: 'supports', subject: client.transitionId },
          matched: {
            transitionId: client.transitionId,
            match: { ...client.search, verdict: 'supports', rule: 'action-matched-static' },
          },
        });
      } else if (client.kind === 'ambiguous') {
        steps.push(ignored(step, { kind: 'ambiguous-trigger', candidates: client.candidates }));
      } else if (client.kind === 'runtime-only') {
        const { transition } = client;
        steps.push({
          outcome: { step, kind: 'created', subject: transition.id },
          matched: { transitionId: transition.id, match: { ...client.search, verdict: 'supports', rule: 'action-runtime-only' } },
          created: transition,
        });
      } else {
        steps.push(ignored(step, { kind: 'unknown-trigger' }));
      }
    }

    for (let hop = 0; hop < chain.length - 1; hop++) {
      const step = { kind: 'redirect', seq, hop } as const;
      const url = chain[hop];
      if (url === undefined) break;
      const source = resolve(url);
      const target = targetOf(chain, hop + 1);
      if (source.kind === 'not-a-screen') {
        steps.push(ignored(step, { kind: 'redirect-from-non-screen', url }));
      } else if (L.httpStatus >= 400) {
        steps.push(ignored(step, { kind: 'landing-error', url: L.url, httpStatus: L.httpStatus }));
      } else if (target.kind === 'not-a-screen') {
        steps.push(ignored(step, { kind: 'not-a-screen', url: target.url, why: target.why }));
      } else {
        const [matched] = staticMatch(source.pattern, ['redirect'], target.pattern);
        if (matched === undefined) {
          // Runtime adds edges only from screens it captured, and this hop never rendered.
          steps.push(ignored(step, { kind: 'unmatched-redirect', from: source.pattern, to: target.pattern }));
        } else {
          steps.push({
            outcome: { step, kind: 'supports', subject: matched },
            matched: {
              transitionId: matched,
              match: {
                sourceUrl: url,
                sourcePattern: source.pattern,
                targetUrl: target.url,
                targetPattern: target.pattern,
                skipped: target.skipped,
                triggerCandidates: ['redirect'],
                verdict: 'supports',
                rule: 'redirect-matched-static',
                hop,
              },
            },
          });
        }
      }
    }

    const start: NavigationEvidenceStart =
      navigation.start.kind === 'entry'
        ? navigation.start
        : {
            kind: 'action',
            from: { evidenceId: navigation.start.from.id, url: navigation.start.from.url },
            action: navigation.start.action,
          };
    const identity = {
      kind: 'navigation',
      runId: validated.run.id,
      start,
      requested: navigation.requested,
    } as const;
    const id = evidenceId(identity);
    let entry = navigations.get(id);
    if (entry === undefined) {
      entry = {
        evidence: {
          ...identity,
          id,
          redirects: navigation.redirects,
          landing: { evidenceId: L.id, url: L.url, httpStatus: L.httpStatus, screenshot: L.screenshot, dom: L.dom },
          logSeq: seq,
        },
        matches: new Map(),
      };
      navigations.set(id, entry);
    }
    for (const step of steps) {
      report.push(step.outcome);
      if (!('matched' in step)) continue;
      if (!entry.matches.has(step.matched.transitionId)) entry.matches.set(step.matched.transitionId, step.matched);
      if (step.created !== undefined && !created.has(step.created.id)) created.set(step.created.id, step.created);
    }
  }

  return {
    analysisId: analysis.id,
    run: validated.run,
    captures,
    navigations: [...navigations.values()]
      .map(({ evidence, matches }) => ({
        evidence,
        matches: [...matches.values()].sort((a, b) => (a.transitionId < b.transitionId ? -1 : 1)),
      }))
      .sort((a, b) => byId(a.evidence, b.evidence)),
    created: [...created.values()].sort(byId),
    report,
  };
}
