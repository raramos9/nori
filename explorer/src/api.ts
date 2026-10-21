import type { ExplorerGraph } from '../../src/explorer/view.js';

export type SourceSnippet = {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

// The server is the same package and built together, so its JSON is trusted to match the shared types.
export async function fetchGraph(): Promise<ExplorerGraph> {
  return (await getJson('/api/graph')) as ExplorerGraph;
}

export async function fetchSnippet(evidenceId: string): Promise<SourceSnippet> {
  return (await getJson(`/api/source?evidence=${encodeURIComponent(evidenceId)}`)) as SourceSnippet;
}
