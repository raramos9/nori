import Link from 'next/link';
import { listProjects } from '@/lib/projects';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const projects = await listProjects();

  return (
    <>
      <h1>Projects</h1>
      <Link href="/projects/new" className="button">
        New project
      </Link>
      <table>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>
                <Link href={`/projects/${project.id}`}>{project.name}</Link>
              </td>
              <td>{project.openTasks} open tasks</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
