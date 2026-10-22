import Link from 'next/link';
import { ActivityFeed } from '@/components/activity-feed';
import { listProjects } from '@/lib/projects';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const projects = (await listProjects()).slice(0, 2);

  return (
    <>
      <h1>Dashboard</h1>
      <section>
        <h2>Recent projects</h2>
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`}>{project.name}</Link> ({project.openTasks} open)
            </li>
          ))}
        </ul>
        <Link href="/projects/new" className="button">
          New project
        </Link>
      </section>
      <section>
        <h2>Activity</h2>
        <ActivityFeed />
      </section>
    </>
  );
}
