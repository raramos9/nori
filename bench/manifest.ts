import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const App = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  root: z
    .string()
    .min(1)
    .refine((root) => !root.startsWith('/') && !root.split('/').includes('..'), 'root must be relative without ..'),
});

const Manifest = z.object({ picked: z.string(), apps: z.array(App).min(1) });

export type BenchApp = z.infer<typeof App>;
export type Manifest = z.infer<typeof Manifest>;

export function parseManifest(json: unknown): Manifest {
  return Manifest.parse(json);
}

export async function loadManifest({ path }: { path: URL | string }): Promise<Manifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}
