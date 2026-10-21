import { NoriError } from '../errors.js';
import { parseRoutePattern, type RoutePattern } from '../graph/model.js';

export const APP_DIRS = ['app', 'src/app'] as const;
export type AppDir = (typeof APP_DIRS)[number];

export type RouteSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'dynamic'; readonly name: string }
  | { readonly kind: 'catch-all'; readonly name: string }
  | { readonly kind: 'optional-catch-all'; readonly name: string };

export type RouteFile = {
  readonly kind: 'page' | 'handler';
  readonly file: string;
  readonly segments: readonly RouteSegment[];
  readonly pattern: RoutePattern;
};

export type RouteTable = {
  readonly appDir: AppDir;
  readonly routes: readonly RouteFile[];
};

const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js|mdx)$/;
const HANDLER_FILE = /^route\.(?:ts|js|tsx|jsx)$/;
const INTERCEPTING = /^\(\.{1,3}\)/;
const GROUP = /^\(.+\)$/;
const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.([^[\]]+)\]\]$/;
const CATCH_ALL = /^\[\.\.\.([^[\]]+)\]$/;
const DYNAMIC = /^\[([^[\]]+)\]$/;

type DirectoryRole =
  | { readonly kind: 'skip' }
  | { readonly kind: 'transparent' }
  | { readonly kind: 'segment'; readonly segment: RouteSegment };

const SKIP: DirectoryRole = { kind: 'skip' };
const TRANSPARENT: DirectoryRole = { kind: 'transparent' };

function segment(segment: RouteSegment): DirectoryRole {
  return { kind: 'segment', segment };
}

function classifyDirectory(name: string): DirectoryRole {
  if (name.startsWith('_') || INTERCEPTING.test(name)) return SKIP;
  if (GROUP.test(name) || name.startsWith('@')) return TRANSPARENT;
  const optionalCatchAll = OPTIONAL_CATCH_ALL.exec(name)?.[1];
  if (optionalCatchAll !== undefined) return segment({ kind: 'optional-catch-all', name: optionalCatchAll });
  const catchAll = CATCH_ALL.exec(name)?.[1];
  if (catchAll !== undefined) return segment({ kind: 'catch-all', name: catchAll });
  const dynamic = DYNAMIC.exec(name)?.[1];
  if (dynamic !== undefined) return segment({ kind: 'dynamic', name: dynamic });
  return segment({ kind: 'static', value: name });
}

function segmentsOf(directories: readonly string[]): readonly RouteSegment[] | null {
  const segments: RouteSegment[] = [];
  for (const directory of directories) {
    const role = classifyDirectory(directory);
    switch (role.kind) {
      case 'skip':
        return null;
      case 'transparent':
        break;
      case 'segment':
        segments.push(role.segment);
        break;
      default: {
        const _exhaustive: never = role;
        return _exhaustive;
      }
    }
  }
  return segments;
}

function renderSegment(segment: RouteSegment): string {
  switch (segment.kind) {
    case 'static':
      return segment.value;
    case 'dynamic':
      return `[${segment.name}]`;
    case 'catch-all':
      return `[...${segment.name}]`;
    case 'optional-catch-all':
      return `[[...${segment.name}]]`;
    default: {
      const _exhaustive: never = segment;
      return _exhaustive;
    }
  }
}

function fileKind(name: string): RouteFile['kind'] | null {
  if (PAGE_FILE.test(name)) return 'page';
  if (HANDLER_FILE.test(name)) return 'handler';
  return null;
}

function patternOf({ file, segments }: { file: string; segments: readonly RouteSegment[] }): RoutePattern {
  const rendered = `/${segments.map(renderSegment).join('/')}`;
  try {
    return parseRoutePattern(rendered);
  } catch (error) {
    throw new NoriError(`${file}: directory name is not supported in a route pattern (${rendered})`, {
      cause: error,
    });
  }
}

export function discoverRoutes({
  files,
  appDir,
}: {
  files: readonly string[];
  appDir: AppDir;
}): RouteTable {
  const prefix = `${appDir}/`;
  const routes: RouteFile[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const relative = file.slice(prefix.length);
    const lastSlash = relative.lastIndexOf('/');
    const kind = fileKind(relative.slice(lastSlash + 1));
    if (kind === null) continue;
    const directories = lastSlash === -1 ? [] : relative.slice(0, lastSlash).split('/');
    const segments = segmentsOf(directories);
    if (segments === null) continue;
    routes.push({ kind, file, segments, pattern: patternOf({ file, segments }) });
  }
  routes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { appDir, routes };
}
