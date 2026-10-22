import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readVersion } from '../version.js';
import { readSnippet, sourceIndex } from '../explorer/source.js';
import type { ExplorerGraph, ExplorerScreen, ExplorerTransition } from '../explorer/view.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const statusSchema = z.enum(['inferred', 'observed', 'verified', 'failed']);

const buildSchema = z.object({
  id: z.string(),
  commitSha: z.string(),
  branch: z.string().nullable(),
  analyzerVersion: z.string(),
});

const sourceSchema = z.object({
  evidenceId: z.string(),
  file: z.string(),
  start: z.object({ line: z.number(), column: z.number() }),
  end: z.object({ line: z.number(), column: z.number() }),
  extractor: z.string(),
});

const screenSchema = z.object({
  id: z.string(),
  route: z.string(),
  status: statusSchema,
  sources: z.array(sourceSchema),
});

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), screenId: z.string(), route: z.string() }),
  z.object({ kind: z.literal('unresolved'), reason: z.string(), expression: z.string() }),
]);

const transitionShape = {
  id: z.string(),
  trigger: z.string(),
  status: statusSchema,
  sources: z.array(sourceSchema),
};

function respond(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createMcpServer({ graph, realRoot }: { graph: ExplorerGraph; realRoot: string }): McpServer {
  const { build } = graph;
  const buildInfo = {
    id: build.id,
    commitSha: build.commitSha,
    branch: build.branch,
    analyzerVersion: build.analyzerVersion,
  };

  const screens = new Map<string, ExplorerScreen>(graph.screens.map((screen) => [screen.id, screen]));
  const outgoing = new Map<string, ExplorerTransition[]>();
  const incoming = new Map<string, ExplorerTransition[]>();
  const push = (index: Map<string, ExplorerTransition[]>, key: string, transition: ExplorerTransition) => {
    const list = index.get(key);
    if (list === undefined) index.set(key, [transition]);
    else list.push(transition);
  };
  for (const transition of graph.transitions) {
    push(outgoing, transition.sourceScreenId, transition);
    if (transition.target.kind === 'screen') push(incoming, transition.target.screenId, transition);
  }
  const sources = sourceIndex(graph);

  const routeOf = (id: string): string => screens.get(id)?.route ?? '';
  const describe = (transition: ExplorerTransition) => ({
    id: transition.id,
    trigger: transition.trigger,
    status: transition.status,
    sources: transition.sources,
  });

  const server = new McpServer({ name: 'nori', version: readVersion() });

  server.registerTool(
    'list_screens',
    {
      description:
        'List every screen found in the analyzed Next.js app, sorted by route, with its evidence status and how many navigation transitions leave it. Start here, then call get_screen with a screen id.',
      annotations: READ_ONLY,
      outputSchema: {
        build: buildSchema,
        screens: z.array(
          screenSchema.extend({
            outgoing: z.number().describe('Transitions leaving this screen'),
            unresolvedOutgoing: z
              .number()
              .describe('Of those, navigation calls the static analysis could not pin to a route'),
          }),
        ),
      },
    },
    () =>
      respond({
        build: buildInfo,
        screens: [...graph.screens]
          .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
          .map((screen) => {
            const leaving = outgoing.get(screen.id) ?? [];
            return {
              id: screen.id,
              route: screen.route,
              status: screen.status,
              sources: screen.sources,
              outgoing: leaving.length,
              unresolvedOutgoing: leaving.filter(({ target }) => target.kind === 'unresolved').length,
            };
          }),
      }),
  );

  server.registerTool(
    'get_screen',
    {
      description:
        'Get one screen with the transitions leaving it and arriving at it. An unresolved target is a navigation call the static analysis could not pin to a route; its expression is the source text. Pass any sources[].evidenceId to read_source.',
      annotations: READ_ONLY,
      inputSchema: { screenId: z.string().describe('A screen id from list_screens') },
      outputSchema: {
        build: buildSchema,
        screen: screenSchema,
        outgoing: z.array(z.object({ ...transitionShape, target: targetSchema })),
        incoming: z.array(
          z.object({ ...transitionShape, sourceScreenId: z.string(), sourceRoute: z.string() }),
        ),
      },
    },
    ({ screenId }) => {
      const screen = screens.get(screenId);
      if (screen === undefined) return toolError(`No screen with id ${JSON.stringify(screenId)} in this build`);
      return respond({
        build: buildInfo,
        screen,
        outgoing: (outgoing.get(screenId) ?? []).map((transition) => ({
          ...describe(transition),
          target:
            transition.target.kind === 'screen'
              ? { kind: 'screen', screenId: transition.target.screenId, route: routeOf(transition.target.screenId) }
              : transition.target,
        })),
        incoming: (incoming.get(screenId) ?? []).map((transition) => ({
          ...describe(transition),
          sourceScreenId: transition.sourceScreenId,
          sourceRoute: routeOf(transition.sourceScreenId),
        })),
      });
    },
  );

  server.registerTool(
    'read_source',
    {
      description:
        'Follow a provenance link: read the source lines (with a few lines of context) behind a screen or transition. Takes an evidenceId from a sources[] entry.',
      annotations: READ_ONLY,
      inputSchema: { evidenceId: z.string().describe('An evidenceId from a sources[] entry') },
      outputSchema: {
        build: buildSchema,
        evidenceId: z.string(),
        file: z.string(),
        start: sourceSchema.shape.start,
        end: sourceSchema.shape.end,
        extractor: z.string(),
        startLine: z.number().describe('Line number of lines[0]'),
        lines: z.array(z.string()),
      },
    },
    async ({ evidenceId }) => {
      const ref = sources.get(evidenceId);
      if (ref === undefined) return toolError(`No evidence with id ${JSON.stringify(evidenceId)} in this build`);
      const snippet = await readSnippet({ realRoot, ref });
      if (snippet === null) return toolError(`The source for evidence ${JSON.stringify(evidenceId)} is not readable`);
      return respond({
        build: buildInfo,
        evidenceId: ref.evidenceId,
        file: ref.file,
        start: ref.start,
        end: ref.end,
        extractor: ref.extractor,
        startLine: snippet.startLine,
        lines: snippet.lines,
      });
    },
  );

  return server;
}
