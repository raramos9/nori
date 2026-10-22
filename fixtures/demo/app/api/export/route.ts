import { listProjects } from '@/lib/projects';

export async function GET() {
  const projects = await listProjects();
  return new Response(JSON.stringify(projects), {
    headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="projects.json"' },
  });
}
