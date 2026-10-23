import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readVersion } from '../version.js';
import { readSnippet } from '../explorer/source.js';
import type { ExplorerTransition } from '../explorer/view.js';
import type { Served } from './live.js';
import { primaryScreenshot, type GraphIndex } from './snapshot.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const statusSchema = z.enum(['inferred', 'observed', 'verified', 'failed']);

const buildSchema = z.object({
  id: z.string(),
  commitSha: z.string(),
  branch: z.string().nullable(),
  analyzerVersion: z.string(),
  refreshError: z
    .string()
    .nullable()
    .describe(
      'Set when re-analysing after a source change failed; the graph is from the last successful analysis',
    ),
});

const sourceSchema = z.object({
  evidenceId: z.string(),
  file: z.string(),
  start: z.object({ line: z.number(), column: z.number() }),
  end: z.object({ line: z.number(), column: z.number() }),
  extractor: z.string(),
});

const captureSchema = z.object({
  evidenceId: z.string(),
  runId: z.string(),
  session: z.string().describe("'anonymous' or the storage-state label of the crawl"),
  url: z.string(),
  httpStatus: z.number(),
  verdict: z.enum(['supports', 'contradicts']),
  screenshotPath: z.string().describe('Absolute path to a PNG; Read it to see the page'),
  domPath: z.string().describe('Absolute path to the raw HTML of the crawled page'),
});

const screenSchema = z.object({
  id: z.string(),
  route: z.string(),
  status: statusSchema,
  sources: z.array(sourceSchema),
  captures: z.array(captureSchema),
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
  runtimeOnly: z.boolean().describe('Seen in a crawl but not in the static analysis, so sources is empty'),
  observedIn: z.array(z.string()).describe("Sessions whose crawl walked this transition: 'anonymous' or a storage-state label"),
  mayExplain: z
    .array(z.string())
    .optional()
    .describe('Runtime-only transitions only: ids of unresolved static transitions from the same screen with the same trigger that this transition may be'),
};

function respond(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createMcpServer({ current, realRoot }: { current: () => Promise<Served>; realRoot: string }): McpServer {
  const routeOf = (index: GraphIndex, id: string): string => index.screens.get(id)?.route ?? '';
  const describe = (transition: ExplorerTransition) => ({
    id: transition.id,
    trigger: transition.trigger,
    status: transition.status,
    sources: transition.sources,
    runtimeOnly: transition.runtimeOnly,
    observedIn: transition.observedIn,
    ...(transition.runtimeOnly ? { mayExplain: transition.mayExplain } : {}),
  });
  const buildInfo = ({ snapshot, refreshError }: Served) => ({
    id: snapshot.graph.build.id,
    commitSha: snapshot.graph.build.commitSha,
    branch: snapshot.graph.build.branch,
    analyzerVersion: snapshot.graph.build.analyzerVersion,
    refreshError,
  });

  const server = new McpServer({ name: 'nori', version: readVersion() });

  server.registerTool(
    'list_screens',
    {
      description:
        'List every screen found in the analyzed Next.js app, sorted by route, with its evidence status and how many navigation transitions leave it. screenshotPath is a crawled screenshot of the screen (a PNG you can Read), or null if no crawl rendered it. Start here, then call get_screen with a screen id for its transitions and evidence.',
      annotations: READ_ONLY,
      outputSchema: {
        build: buildSchema,
        screens: z.array(
          screenSchema.omit({ sources: true, captures: true }).extend({
            outgoing: z.number().describe('Transitions leaving this screen'),
            screenshotPath: z.string().nullable().describe('Absolute path to a PNG of the crawled screen; Read it to see the page'),
            unresolvedOutgoing: z
              .number()
              .describe('Of those, navigation calls the static analysis could not pin to a route'),
          }),
        ),
      },
    },
    async () => {
      const served = await current();
      const { graph, index } = served.snapshot;
      return respond({
        build: buildInfo(served),
        screens: [...graph.screens]
          .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
          .map((screen) => {
            const leaving = index.outgoing.get(screen.id) ?? [];
            return {
              id: screen.id,
              route: screen.route,
              status: screen.status,
              outgoing: leaving.length,
              screenshotPath: primaryScreenshot(screen),
              unresolvedOutgoing: leaving.filter(({ target }) => target.kind === 'unresolved').length,
            };
          }),
      });
    },
  );

  server.registerTool(
    'get_screen',
    {
      description:
        'Get one screen with the transitions leaving it and arriving at it. An unresolved target is a navigation call the static analysis could not pin to a route; its expression is the source text. screen.captures[] are the crawled renders: Read a screenshotPath to see the page, or domPath for its HTML. Transitions seen only at runtime have runtimeOnly set; observedIn says which crawl sessions walked a transition. Pass any sources[].evidenceId to read_source.',
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
    async ({ screenId }) => {
      const served = await current();
      const { index } = served.snapshot;
      const screen = index.screens.get(screenId);
      if (screen === undefined) return toolError(`No screen with id ${JSON.stringify(screenId)} in this build`);
      return respond({
        build: buildInfo(served),
        screen,
        outgoing: (index.outgoing.get(screenId) ?? []).map((transition) => ({
          ...describe(transition),
          target:
            transition.target.kind === 'screen'
              ? { kind: 'screen', screenId: transition.target.screenId, route: routeOf(index, transition.target.screenId) }
              : transition.target,
        })),
        incoming: (index.incoming.get(screenId) ?? []).map((transition) => ({
          ...describe(transition),
          sourceScreenId: transition.sourceScreenId,
          sourceRoute: routeOf(index, transition.sourceScreenId),
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
      const served = await current();
      const ref = served.snapshot.index.sources.get(evidenceId);
      if (ref === undefined) return toolError(`No evidence with id ${JSON.stringify(evidenceId)} in this build`);
      const snippet = await readSnippet({ realRoot, ref });
      if (snippet === null) return toolError(`The source for evidence ${JSON.stringify(evidenceId)} is not readable`);
      return respond({
        build: buildInfo(served),
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
