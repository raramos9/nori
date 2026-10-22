export type Project = { id: string; name: string; openTasks: number };

const PROJECTS: readonly Project[] = [
  { id: 'apollo', name: 'Apollo launch', openTasks: 14 },
  { id: 'billing-revamp', name: 'Billing revamp', openTasks: 6 },
  { id: 'mobile', name: 'Mobile app', openTasks: 23 },
];

export async function listProjects(): Promise<readonly Project[]> {
  return PROJECTS;
}

export async function getProject(id: string): Promise<Project | null> {
  return PROJECTS.find((project) => project.id === id) ?? null;
}
