import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NoriError } from '../errors.js';
import type { Command } from './command.js';

export const MARKER = '<!-- nori-diff -->';
export const COMMENT_LIMIT = 65536;
export const TRUNCATION_NOTICE = "\n\n_The diff was cut to fit GitHub's comment limit. The job summary has the whole diff._";

const PAGE_SIZE = 100;
const USAGE = 'usage: nori comment <markdown-file>\n';

export type CommentTarget = {
  readonly apiUrl: string;
  readonly token: string;
  readonly repository: string;
  readonly pullNumber: number;
};

export type CommentOutcome =
  | { readonly kind: 'created' | 'updated'; readonly id: number }
  | { readonly kind: 'skipped-read-only'; readonly status: number };

const EventSchema = z.object({ pull_request: z.object({ number: z.number().int().positive() }) });
const CommentPageSchema = z.array(
  z.object({ id: z.number().int(), body: z.string().nullish(), user: z.object({ type: z.string() }).nullish() }),
);
const CommentIdSchema = z.object({ id: z.number().int() });
const RepositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

export function commentBody(markdown: string): string {
  const body = `${MARKER}\n${markdown}`;
  if (body.length <= COMMENT_LIMIT) return body;
  const budget = COMMENT_LIMIT - TRUNCATION_NOTICE.length;
  const cut = markdown.lastIndexOf('\n', budget - MARKER.length - 1);
  return `${MARKER}${TRUNCATION_NOTICE}\n\n${markdown.slice(0, cut > 0 ? cut : budget - MARKER.length - 2)}`;
}

class GitHubError extends NoriError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call({
  target,
  method,
  path,
  body,
}: {
  target: CommentTarget;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: string;
}): Promise<Response> {
  const response = await fetch(`${target.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nori',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
  });
  if (response.ok) return response;
  const detail = (await response.text()).slice(0, 500);
  throw new GitHubError(response.status, `GitHub ${method} ${path} failed with ${response.status}: ${detail}`);
}

const hasNextPage = (link: string | null) => link === null || /rel="next"/.test(link);

// Anyone can write a comment that starts with the marker, so a bot's (the Actions token's) wins over a person's.
async function findComment(target: CommentTarget, issuePath: string): Promise<number | undefined> {
  const marked: z.infer<typeof CommentPageSchema> = [];
  for (let page = 1; ; page++) {
    const response = await call({ target, method: 'GET', path: `${issuePath}?per_page=${PAGE_SIZE}&page=${page}` });
    const comments = CommentPageSchema.parse(await response.json());
    marked.push(...comments.filter(({ body }) => body?.startsWith(MARKER)));
    if (comments.length < PAGE_SIZE || !hasNextPage(response.headers.get('link'))) break;
  }
  return (marked.find(({ user }) => user?.type === 'Bot') ?? marked[0])?.id;
}

export async function postComment({
  target,
  markdown,
}: {
  target: CommentTarget;
  markdown: string;
}): Promise<CommentOutcome> {
  const repo = `/repos/${target.repository}`;
  const issuePath = `${repo}/issues/${target.pullNumber}/comments`;
  const body = commentBody(markdown);
  const existing = await findComment(target, issuePath);
  const create = async (): Promise<CommentOutcome> => {
    const created = await call({ target, method: 'POST', path: issuePath, body });
    return { kind: 'created', id: CommentIdSchema.parse(await created.json()).id };
  };
  try {
    if (existing === undefined) return await create();
    try {
      await call({ target, method: 'PATCH', path: `${repo}/issues/comments/${existing}`, body });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) return await create();
      throw error;
    }
    return { kind: 'updated', id: existing };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403) return { kind: 'skipped-read-only', status: error.status };
    throw error;
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new NoriError(`${name} is not set`);
  return value;
}

async function readPullNumber(eventPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(eventPath, 'utf8');
  } catch (error) {
    throw new NoriError(`cannot read the event file ${eventPath}: ${error instanceof Error ? error.message : error}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new NoriError(`the event file ${eventPath} is not JSON`);
  }
  const event = EventSchema.safeParse(json);
  if (!event.success) {
    throw new NoriError(`the event file ${eventPath} is not a pull_request event: ${z.prettifyError(event.error)}`);
  }
  return event.data.pull_request.number;
}

export async function readTarget(env: NodeJS.ProcessEnv): Promise<CommentTarget> {
  const repository = RepositorySchema.safeParse(requireEnv(env, 'GITHUB_REPOSITORY'));
  if (!repository.success) throw new NoriError('GITHUB_REPOSITORY must look like owner/repo');
  const apiUrl = (env['GITHUB_API_URL'] || 'https://api.github.com').replace(/\/+$/, '');
  return {
    apiUrl,
    token: requireEnv(env, 'GITHUB_TOKEN'),
    repository: repository.data,
    pullNumber: await readPullNumber(requireEnv(env, 'GITHUB_EVENT_PATH')),
  };
}

export async function runComment(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...extra] = argv;
  if (file === undefined || extra.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const target = await readTarget(env);
  const outcome = await postComment({ target, markdown: await readFile(file, 'utf8') });
  switch (outcome.kind) {
    case 'created':
    case 'updated':
      process.stdout.write(`nori: ${outcome.kind} comment ${outcome.id}\n`);
      return 0;
    case 'skipped-read-only':
      process.stdout.write(
        `::warning::nori could not write the PR comment (HTTP ${outcome.status}); the token is read-only, as on fork PRs. The diff is in the job summary.\n`,
      );
      return 0;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export const commentCommand: Command = {
  summary: 'post a markdown file as the PR comment, editing the earlier one in place',
  run: (argv) => runComment(argv, process.env),
};
