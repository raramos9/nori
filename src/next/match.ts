import type { RoutePattern, UnresolvedReason } from '../graph/model.js';
import type { PathTemplate } from './evaluate.js';
import type { RouteFile, RouteSegment, RouteTable } from './routes.js';

export type MatchSegment = RouteSegment | { readonly kind: 'optional-dynamic'; readonly name: string };
export type MatchRoute = { readonly route: RouteFile; readonly host: string | null; readonly segments: readonly MatchSegment[] };

export type Resolution =
  | { readonly kind: 'screen'; readonly pattern: RoutePattern }
  | { readonly kind: 'excluded'; readonly why: 'external' | 'same-page' | 'asset' | 'handler' }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason };

export type Matcher = {
  readonly routes: readonly MatchRoute[];
  readonly assets: ReadonlySet<string>;
  readonly adapters: boolean;
};

type TargetSegment = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'hole' };

const PUBLIC_DIR = 'public/';
const LOCALE_NAME = /^(?:locale|lang|lng|language)$/;
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const BRACKETED = /^\[{1,2}(?:\.\.\.)?[\w-]+\]{1,2}$/;
const SPECIFICITY: Record<MatchSegment['kind'], number> = {
  static: 3,
  dynamic: 2,
  'optional-dynamic': 2,
  'catch-all': 1,
  'optional-catch-all': 0,
};

const unresolved = (reason: UnresolvedReason): Resolution => ({ kind: 'unresolved', reason });
const excluded = (why: Extract<Resolution, { kind: 'excluded' }>['why']): Resolution => ({ kind: 'excluded', why });

function dottedFolder(route: RouteFile): string | null {
  const [first] = route.segments;
  return first?.kind === 'static' && first.value.includes('.') ? first.value : null;
}

function matchRoute(route: RouteFile, hosts: ReadonlySet<string>, adapters: boolean): MatchRoute {
  let segments: readonly MatchSegment[] = route.segments;
  if (!adapters) return { route, host: null, segments };
  const folder = dottedFolder(route);
  const host = folder !== null && hosts.has(folder) ? folder : null;
  if (host !== null) segments = segments.slice(1);
  const [lead, ...rest] = segments;
  if (lead?.kind === 'dynamic' && LOCALE_NAME.test(lead.name)) {
    segments = [{ kind: 'optional-dynamic', name: lead.name }, ...rest];
  }
  return { route, host, segments };
}

// A dotted folder with no page under it is a file-like handler (rss.xml, typeset.css), not a hostname.
export function createMatcher({
  table,
  files,
  adapters,
}: {
  table: RouteTable;
  files: readonly string[];
  adapters: boolean;
}): Matcher {
  const assets = new Set(
    files.filter((file) => file.startsWith(PUBLIC_DIR)).map((file) => `/${file.slice(PUBLIC_DIR.length)}`),
  );
  const hosts = new Set(
    table.routes.flatMap((route) => {
      const folder = route.kind === 'page' ? dottedFolder(route) : null;
      return folder === null ? [] : [folder];
    }),
  );
  return { routes: table.routes.map((route) => matchRoute(route, hosts, adapters)), assets, adapters };
}

function segmentMatches(target: readonly TargetSegment[], route: readonly MatchSegment[]): boolean {
  const go = (i: number, j: number): boolean => {
    const r = route[j];
    if (r === undefined) return i === target.length;
    switch (r.kind) {
      case 'optional-catch-all':
        return true;
      case 'optional-dynamic':
        return go(i, j + 1) || (i < target.length && go(i + 1, j + 1));
      case 'catch-all':
        return i < target.length;
      case 'dynamic':
        return i < target.length && go(i + 1, j + 1);
      case 'static': {
        const t = target[i];
        if (t === undefined) return false;
        return (t.kind === 'hole' || t.value === r.value) && go(i + 1, j + 1);
      }
      default: {
        const _exhaustive: never = r;
        return _exhaustive;
      }
    }
  };
  return go(0, 0);
}

function rank(segment: MatchSegment | undefined): number {
  return segment === undefined ? -1 : SPECIFICITY[segment.kind];
}

function compareSpecificity(a: MatchRoute, b: MatchRoute): number {
  const length = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < length; i++) {
    const difference = rank(b.segments[i]) - rank(a.segments[i]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function cutAtQueryOrHash(template: PathTemplate): PathTemplate {
  const out: PathTemplate[number][] = [];
  for (const part of template) {
    if (part.kind === 'hole') {
      out.push(part);
      continue;
    }
    const cut = part.text.search(/[?#]/);
    if (cut === -1) {
      out.push(part);
      continue;
    }
    if (cut > 0) out.push({ kind: 'text', text: part.text.slice(0, cut) });
    break;
  }
  return out;
}

function splitSegments(template: PathTemplate): TargetSegment[] {
  const segments: TargetSegment[] = [];
  let current = '';
  let hole = false;
  const flush = () => {
    if (hole) segments.push({ kind: 'hole' });
    else if (current !== '') segments.push({ kind: 'text', value: current });
    current = '';
    hole = false;
  };
  for (const part of template) {
    if (part.kind === 'hole') {
      hole = true;
      continue;
    }
    const pieces = part.text.split('/');
    pieces.forEach((piece, i) => {
      if (i > 0) flush();
      current += piece;
    });
  }
  flush();
  return segments;
}

function relativeTo(source: MatchRoute, target: readonly TargetSegment[]): TargetSegment[] {
  const segments: TargetSegment[] = source.segments.map((segment) =>
    segment.kind === 'static' ? { kind: 'text', value: segment.value } : { kind: 'hole' },
  );
  segments.pop();
  for (const segment of target) {
    if (segment.kind === 'text' && segment.value === '.') continue;
    if (segment.kind === 'text' && segment.value === '..') segments.pop();
    else segments.push(segment);
  }
  return segments;
}

function decodedPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function hostsOf(routes: readonly MatchRoute[]): number {
  return new Set(routes.map((route) => route.host)).size;
}

function toScreen(route: MatchRoute): Resolution {
  return route.route.kind === 'handler' ? excluded('handler') : { kind: 'screen', pattern: route.route.pattern };
}

export function resolveTemplate({
  matcher,
  template,
  source,
}: {
  matcher: Matcher;
  template: PathTemplate;
  source: MatchRoute | null;
}): Resolution {
  const [first] = template;
  if (first?.kind === 'hole') return unresolved('dynamic-expression');
  const path = cutAtQueryOrHash(template);
  const [lead] = path;
  if (lead === undefined) return excluded('same-page');
  if (lead.kind === 'text' && EXTERNAL.test(lead.text)) return excluded('external');

  const relative = lead.kind === 'text' && !lead.text.startsWith('/');
  if (relative && source === null) return unresolved('dynamic-expression');
  const split = splitSegments(path);
  const segments = relative && source !== null ? relativeTo(source, split) : split;

  const texts = segments.flatMap((segment) => (segment.kind === 'text' ? [segment.value] : []));
  if (texts.length === segments.length && matcher.assets.has(decodedPath(`/${texts.join('/')}`))) {
    return excluded('asset');
  }
  const target = segments.map(
    (segment): TargetSegment =>
      matcher.adapters && segment.kind === 'text' && BRACKETED.test(segment.value) ? { kind: 'hole' } : segment,
  );

  let hits = matcher.routes.filter((route) => segmentMatches(target, route.segments)).sort(compareSpecificity);
  const host = source?.host ?? null;
  if (host !== null) {
    const own = hits.filter((route) => route.host === host);
    hits = own.length > 0 ? own : hits.filter((route) => route.host === null);
  }
  const [best] = hits;
  if (best === undefined) return unresolved('no-matching-route');

  const holes = target.flatMap((segment, i) => (segment.kind === 'hole' ? [i] : []));
  if (holes.length === 0) {
    const tied = hits.filter((route) => compareSpecificity(route, best) === 0);
    return hostsOf(tied) === 1 ? toScreen(best) : unresolved('ambiguous-route');
  }
  const viaDynamic = hits.filter((route) =>
    holes.every((i) => {
      const segment = route.segments[i];
      return segment !== undefined && segment.kind !== 'static';
    }),
  );
  const [chosen] = viaDynamic;
  if (chosen !== undefined && hostsOf(viaDynamic) === 1) return toScreen(chosen);
  return unresolved('ambiguous-route');
}
