import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorCode, NoriError } from '../errors.js';
import { appKey } from '../graph/ids.js';
import type { AppKey } from '../graph/model.js';
import { gitCommonDir, originUrl, showPrefix, workTreeTop } from './git.js';

export type NetworkRemote = { readonly kind: 'network'; readonly hostPath: string };
export type LocalRemote = { readonly kind: 'local'; readonly path: string };

export type AppIdentity = {
  readonly appKey: AppKey;
  readonly repoIdentity: string;
  readonly subpath: string;
};

const NETWORK_SCHEMES = new Set(['ssh:', 'git+ssh:', 'ssh+git:', 'git:', 'http:', 'https:']);
const SCP_FORM = /^(?:[^@/:]+@)?([^/:]+):(.*)$/;

function network(host: string, rawPath: string): NetworkRemote | null {
  const path = rawPath
    .toLowerCase()
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  if (host === '' || path === '') return null;
  return { kind: 'network', hostPath: `${host.toLowerCase()}/${path}` };
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function normalizeRemote(raw: string): NetworkRemote | LocalRemote | null {
  const value = raw.trim();
  if (value === '') return null;
  if (value.includes('://')) {
    const url = parseUrl(value);
    if (url === null) return null;
    if (url.protocol === 'file:') {
      try {
        return { kind: 'local', path: fileURLToPath(url) };
      } catch {
        return null;
      }
    }
    if (!NETWORK_SCHEMES.has(url.protocol)) return null;
    return network(url.hostname, url.pathname);
  }
  if (value.startsWith('/') || value.startsWith('.')) return { kind: 'local', path: value };
  const scp = SCP_FORM.exec(value);
  if (scp !== null && value.indexOf(':') >= 2) return network(scp[1] ?? '', scp[2] ?? '');
  return { kind: 'local', path: value };
}

async function realpathOrResolve(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return absolute;
    throw error;
  }
}

async function commonDirIdentity({ root }: { root: string }): Promise<string | null> {
  const commonDir = await gitCommonDir({ root });
  if (commonDir === null) return null;
  const real = await realpathOrResolve(commonDir);
  return `local:${real.replace(/\/\.git$/, '')}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// One hop only: the source repository's own local origin is never followed.
async function sourceIdentity({ path }: { path: string }): Promise<string> {
  if (await isDirectory(path)) {
    const origin = await originUrl({ root: path });
    const remote = origin === null ? null : normalizeRemote(origin);
    if (remote?.kind === 'network') return `remote:${remote.hostPath}`;
    const local = await commonDirIdentity({ root: path });
    if (local !== null) return local;
  }
  return `local:${await realpathOrResolve(path)}`;
}

async function readRepoIdentity({ root, top }: { root: string; top: string }): Promise<string> {
  const origin = await originUrl({ root });
  const remote = origin === null ? null : normalizeRemote(origin);
  if (remote?.kind === 'network') return `remote:${remote.hostPath}`;
  if (remote?.kind === 'local') return sourceIdentity({ path: resolve(top, remote.path) });
  const local = await commonDirIdentity({ root });
  if (local === null) throw new NoriError(`git could not find the common directory of ${root}`);
  return local;
}

export async function readAppIdentity({ root }: { root: string }): Promise<AppIdentity> {
  const top = await workTreeTop({ root });
  if (top === null) throw new NoriError(`${root} is not inside a git repository`);
  const subpath = await showPrefix({ root });
  const repoIdentity = await readRepoIdentity({ root, top });
  return { appKey: appKey({ repoIdentity, subpath }), repoIdentity, subpath };
}
