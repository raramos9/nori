import Link from 'next/link';
import { UserMenu } from './user-menu';

const NAV = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Projects', href: '/projects' },
  { label: 'Settings', href: '/settings' },
];

export function AppSidebar({ name }: { name: string }) {
  return (
    <aside className="sidebar">
      <Link href="/dashboard" className="logo">
        Tasks
      </Link>
      <nav>
        <ul>
          {NAV.map(({ label, href }) => (
            <li key={href}>
              <Link href={href}>{label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <a href="https://status.tasks.example.com" target="_blank" rel="noreferrer">
        System status
      </a>
      <UserMenu name={name} />
    </aside>
  );
}
