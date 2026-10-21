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

function expressionText(call: NavCall): string {
  return call.expression.getText().replace(/\s+/g, ' ').trim().slice(0, MAX_EXPRESSION_LENGTH);
}

export function navigationIngestion({
  application,
  build,
  root,
  files,
  table,
}: {
  application: Application;
  build: Build;
  root: string;
  files: readonly SourceFile[];
  table: RouteTable;
}): NavigationIngestion {
  const program = createProgram({ root, files });
  const evaluate = createEvaluator(program);
  const paths = files.map((file) => file.path);
  const matcher = createMatcher({ table, files: paths });
  const reach = screensByFile({ program, root, table, files: paths });
  const pages = new Map<RoutePattern, MatchRoute>();
  for (const route of matcher.routes) {
    if (route.route.kind === 'page' && !pages.has(route.route.pattern)) pages.set(route.route.pattern, route);
  }
  const stateOf = (pattern: RoutePattern): StateId =>
    stateId({ screenId: screenId({ applicationId: application.id, routePattern: pattern }), key: DEFAULT_STATE_KEY });

  const transitions = new Map<TransitionId, Transition>();
  const evidence: Evidence[] = [];
  const observations: Observation[] = [];
  const outcomes: CallOutcome[] = [];

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

      const backed = new Set<TransitionId>();
      const contexts: CallOutcome['contexts'][number][] = [];
      for (const source of sources) {
        const targets = targetsIn(evaluated, matcher, pages.get(source) ?? null);
        contexts.push({ source, classification: classify(targets) });
        const sourceStateId = stateOf(source);
        const add = (target: TransitionTarget) => {
          const id = transitionId({ sourceStateId, trigger: call.trigger, target });
          if (!transitions.has(id)) transitions.set(id, { id, sourceStateId, trigger: call.trigger, target });
          backed.add(id);
        };
        for (const pattern of targets.screens) add({ kind: 'resolved', stateId: stateOf(pattern) });
        if (targets.unresolved !== null) {
          add({ kind: 'unresolved', reason: targets.unresolved, expression: expressionText(call) });
        }
      }
      outcomes.push({ call, contexts });
      if (backed.size === 0) continue;

      const identity = { kind: 'static', buildId: build.id, span: call.span, extractor: NAV_EXTRACTOR } as const;
      const callEvidence: Evidence = { ...identity, id: evidenceId(identity) };
      evidence.push(callEvidence);
      for (const id of backed) {
        observations.push({ evidenceId: callEvidence.id, subject: { kind: 'transition', id }, verdict: 'supports' });
      }
    }
  }

  return { transitions: [...transitions.values()], evidence, observations, outcomes };
}
