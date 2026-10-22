export type Project = { id: string; name: string };

export const PROJECTS: readonly Project[] = [
  { id: 'p-100', name: 'Website relaunch' },
  { id: 'p-200', name: 'Mobile app' },
  { id: 'p-300', name: 'Billing migration' },
];

export function findProject(id: string): Project | null {
  return PROJECTS.find((project) => project.id === id) ?? null;
}
