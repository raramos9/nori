import { join } from 'node:path';
import { evidenceId, screenId, stateId, transitionId } from '../graph/ids.js';
import {
  DEFAULT_STATE_KEY,
  type Application,
  type Build,
  type Evidence,
  type Observation,
  type RoutePattern,
  type StateId,
  type Transition,
  type TransitionId,
  type TransitionTarget,
  type UnresolvedReason,
} from '../graph/model.js';
import type { SourceFile } from '../graph/source-hash.js';
import { createEvaluator, type Evaluated } from '../next/evaluate.js';
import { createMatcher, resolveTemplate, type Matcher, type MatchRoute, type Resolution } from '../next/match.js';
import { findNavCalls, NAV_EXTRACTOR, type NavCall } from '../next/nav-calls.js';
import { createProgram, isProgramFile } from '../next/program.js';
import { screensByFile } from '../next/reach.js';
import { redirectOnlyPages } from '../next/redirect-pages.js';
import type { RouteTable } from '../next/routes.js';

export type CallClassification = Exclude<Resolution, { kind: 'screen' }> | { readonly kind: 'resolved' };

export type CallOutcome = {
  readonly call: NavCall;
  readonly contexts: readonly { readonly source: RoutePattern | null; readonly classification: CallClassification }[];
};

export type NavigationIngestion = {
  readonly transitions: readonly Transition[];
  readonly evidence: readonly Evidence[];
  readonly observations: readonly Observation[];
  readonly outcomes: readonly CallOutcome[];
};

const REASON_PRIORITY: readonly UnresolvedReason[] = ['dynamic-expression', 'no-matching-route', 'ambiguous-route'];
const MAX_EXPRESSION_LENGTH = 200;

type Targets = {
  readonly screens: readonly RoutePattern[];
  readonly unresolved: UnresolvedReason | null;
  readonly excluded: Extract<Resolution, { kind: 'excluded' }> | null;
};

function firstReason(reasons: readonly UnresolvedReason[]): UnresolvedReason | null {
  return REASON_PRIORITY.find((reason) => reasons.includes(reason)) ?? reasons[0] ?? null;
}

function targetsIn(evaluated: Evaluated, matcher: Matcher, source: MatchRoute | null): Targets {
  if (evaluated.kind === 'unknown') return { screens: [], unresolved: 'dynamic-expression', excluded: null };
  const resolutions = evaluated.alternatives.map((template) => resolveTemplate({ matcher, template, source }));
  const screens = new Set<RoutePattern>();
  const reasons: UnresolvedReason[] = [];
  for (const resolution of resolutions) {
    if (resolution.kind === 'screen') screens.add(resolution.pattern);
    else if (resolution.kind === 'unresolved') reasons.push(resolution.reason);
  }
  const excluded = resolutions.find((r): r is Extract<Resolution, { kind: 'excluded' }> => r.kind === 'excluded');
  return { screens: [...screens], unresolved: firstReason(reasons), excluded: excluded ?? null };
}

function classify(targets: Targets): CallClassification {
  if (targets.unresolved !== null) return { kind: 'unresolved', reason: targets.unresolved };
  if (targets.screens.length > 0) return { kind: 'resolved' };
  if (targets.excluded !== null) return targets.excluded;
  throw new Error('every alternative was classified, so one must be excluded');
}

type SourcedCall = {
  readonly call: NavCall;
  readonly contexts: readonly { readonly source: RoutePattern; readonly targets: Targets }[];
};

type Forwarding = ReadonlyMap<RoutePattern, readonly RoutePattern[]>;

function forwardingOf(redirectOnly: ReadonlySet<RoutePattern>, calls: readonly SourcedCall[]): Forwarding {
  const destinations = new Map<RoutePattern, Set<RoutePattern>>();
  const unforwardable = new Set<RoutePattern>();
  for (const { contexts } of calls) {
    for (const { source, targets } of contexts) {
      if (!redirectOnly.has(source)) continue;
      if (classify(targets).kind !== 'resolved') unforwardable.add(source);
      else destinations.set(source, new Set([...(destinations.get(source) ?? []), ...targets.screens]));
    }
  }
  return new Map(
    [...destinations].filter(([source]) => !unforwardable.has(source)).map(([source, to]) => [source, [...to]]),
  );
}

function landingsOf(forwarding: Forwarding): (target: RoutePattern) => readonly RoutePattern[] {
  const visiting = new Set<RoutePattern>();
  const walk = (target: RoutePattern): readonly RoutePattern[] | null => {
    const next = forwarding.get(target);
    if (next === undefined) return [target];
    if (visiting.has(target)) return null;
    visiting.add(target);
    const landings = new Set<RoutePattern>();
    for (const destination of next) {
      const reached = walk(destination);
      if (reached === null) {
        visiting.delete(target);
        return null;
      }
      for (const landing of reached) landings.add(landing);
    }
    visiting.delete(target);
    return [...landings];
  };
  const memo = new Map<RoutePattern, readonly RoutePattern[]>();
  return (target) => {
    const cached = memo.get(target);
    if (cached !== undefined) return cached;
    const landings = walk(target) ?? [target];
    memo.set(target, landings);
    return landings;
  };
}

function expressionText(call: NavCall): string {
  return call.expression.getText().replace(/\s+/g, ' ').trim().slice(0, MAX_EXPRESSION_LENGTH);
}

export function navigationIngestion({
  application,
  build,
  root,
  files,
  table,
  adapters,
}: {
  application: Application;
  build: Build;
  root: string;
  files: readonly SourceFile[];
  table: RouteTable;
  adapters: boolean;
}): NavigationIngestion {
  const program = createProgram({ root, files });
  const evaluate = createEvaluator(program, { adapters });
  const paths = files.map((file) => file.path);
  const matcher = createMatcher({ table, files: paths, adapters });
  const redirectOnly = redirectOnlyPages({ program, root, table });
  const reach = screensByFile({ program, root, table, files: paths, redirectOnly });
  const pages = new Map<RoutePattern, MatchRoute>();
  for (const route of matcher.routes) {
    if (route.route.kind === 'page' && !pages.has(route.route.pattern)) pages.set(route.route.pattern, route);
  }
  const stateOf = (pattern: RoutePattern): StateId =>
    stateId({ screenId: screenId({ applicationId: application.id, routePattern: pattern }), key: DEFAULT_STATE_KEY });

  const outcomes: CallOutcome[] = [];
  const sourced: SourcedCall[] = [];
  for (const path of paths.filter(isProgramFile)) {
    const sourceFile = program.getSourceFile(join(root, path));
    if (sourceFile === undefined) continue;
    for (const call of findNavCalls(sourceFile, path)) {
      const evaluated = evaluate(call.expression);
      const sources = [...(reach.get(path) ?? [])].sort();
      if (sources.length === 0) {
        outcomes.push({ call, contexts: [{ source: null, classification: classify(targetsIn(evaluated, matcher, null)) }] });
        continue;
      }
      const contexts = sources.map((source) => ({
        source,
        targets: targetsIn(evaluated, matcher, pages.get(source) ?? null),
      }));
      outcomes.push({
        call,
        contexts: contexts.map(({ source, targets }) => ({ source, classification: classify(targets) })),
      });
      sourced.push({ call, contexts });
    }
  }

  const landings = landingsOf(forwardingOf(redirectOnly, sourced));
  const transitions = new Map<TransitionId, Transition>();
  const evidence: Evidence[] = [];
  const observations: Observation[] = [];
  for (const { call, contexts } of sourced) {
    const backed = new Set<TransitionId>();
    for (const { source, targets } of contexts) {
      const sourceStateId = stateOf(source);
      const add = (target: TransitionTarget) => {
        const id = transitionId({ sourceStateId, trigger: call.trigger, target });
        if (!transitions.has(id)) transitions.set(id, { id, sourceStateId, trigger: call.trigger, target });
        backed.add(id);
      };
      for (const pattern of targets.screens.flatMap(landings)) add({ kind: 'resolved', stateId: stateOf(pattern) });
      if (targets.unresolved !== null) {
        add({ kind: 'unresolved', reason: targets.unresolved, expression: expressionText(call) });
      }
    }
    if (backed.size === 0) continue;

    const identity = { kind: 'static', buildId: build.id, span: call.span, extractor: NAV_EXTRACTOR } as const;
    const callEvidence: Evidence = { ...identity, id: evidenceId(identity) };
    evidence.push(callEvidence);
    for (const id of backed) {
      observations.push({ evidenceId: callEvidence.id, subject: { kind: 'transition', id }, verdict: 'supports' });
    }
  }

  return { transitions: [...transitions.values()], evidence, observations, outcomes };
}
