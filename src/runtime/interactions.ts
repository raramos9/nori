import { z } from 'zod';
import { NoriError } from '../errors.js';
import type { Origin } from '../graph/model.js';
import { pageUrlOrNull } from './crawl.js';
import type { AllowedRequest, Interaction, WriteMethod } from './crawl-result.js';

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const satisfies readonly WriteMethod[];

const allowSchema = z.string().transform((rule, context): AllowedRequest => {
  const match = /^([A-Z]+) (\/\S*)$/.exec(rule);
  const method = WRITE_METHODS.find((candidate) => candidate === match?.[1]);
  const path = match?.[2];
  if (method === undefined || path === undefined || /[?#]/.test(path)) {
    context.addIssue({ code: 'custom', message: `${JSON.stringify(rule)} must be "<POST|PUT|PATCH|DELETE> <pathname>"` });
    return z.NEVER;
  }
  return { method, path };
});

const fileSchema = z.strictObject({
  interactions: z.array(
    z.strictObject({
      page: z.string().min(1),
      fill: z.record(z.string().min(1), z.string()).default({}),
      click: z.string().min(1),
      allow: z.array(allowSchema).min(1),
    }),
  ),
});

// The file is the user's own and never comes from the scanned repo: it is the only thing that can widen
// the crawl policy beyond reads, and only for the requests it names.
export function parseInteractions(origin: Origin, text: string): Interaction[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NoriError('--interactions is not valid JSON');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) throw new NoriError(`--interactions is malformed:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.interactions.map((interaction) => {
    const page = pageUrlOrNull(origin, interaction.page);
    if (page === null) throw new NoriError(`--interactions page ${JSON.stringify(interaction.page)} is not on ${origin}`);
    return {
      page,
      fill: Object.entries(interaction.fill).map(([label, value]) => ({ label, value })),
      click: interaction.click,
      allow: interaction.allow,
    };
  });
}
