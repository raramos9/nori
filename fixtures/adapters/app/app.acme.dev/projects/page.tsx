import Link from 'next/link';
import { PROJECTS } from '@/lib/projects';
import { href } from '@/lib/routes';

export default function ProjectsPage() {
  return (
    <section>
      <h1>Projects</h1>
      <ul>
        {PROJECTS.map((project) => (
          <li key={project.id}>
            <Link href={href('/projects/[id]', { id: project.id })}>{project.name}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
