export type Guide = { slug: string; title: string };

export const GUIDES: readonly Guide[] = [
  { slug: 'getting-started/quickstart', title: 'Quickstart' },
  { slug: 'getting-started/invite-your-team', title: 'Invite your team' },
  { slug: 'projects/timelines', title: 'Timelines' },
  { slug: 'projects/archiving', title: 'Archiving a project' },
];

export function findGuide(slug: readonly string[]): { guide: Guide; previous: Guide | null; next: Guide | null } | null {
  const path = slug.join('/');
  const index = GUIDES.findIndex((guide) => guide.slug === path);
  const guide = GUIDES[index];
  if (guide === undefined) return null;
  return { guide, previous: GUIDES[index - 1] ?? null, next: GUIDES[index + 1] ?? null };
}
