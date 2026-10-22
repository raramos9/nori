import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getProject } from '@/lib/projects';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (project === null) redirect('/projects');

  return (
    <>
      <h1>{project.name}</h1>
      <p>{project.openTasks} open tasks.</p>
      <p>
        Need more than three projects? <Link href="/pricing">Compare plans</Link>.
      </p>
      <Link href="new">Start another project</Link>
    </>
  );
}
