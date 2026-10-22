import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PROJECTS, findProject } from '@/lib/projects';
import { href } from '@/lib/routes';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = findProject(id);
  if (project === null) redirect('/projects');
  const other = PROJECTS.find((candidate) => candidate.id !== project.id);

  return (
    <article>
      <h1>{project.name}</h1>
      {other && <Link href={href('/projects/[id]', { id: other.id })}>Next: {other.name}</Link>}
    </article>
  );
}
