import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>&copy; 2026 Tasks, Inc.</p>
      <ul>
        <li>
          <Link href="/pricing">Pricing</Link>
        </li>
        <li>
          <Link href="/docs">Documentation</Link>
        </li>
        <li>
          <a href="https://github.com/tasks-app/tasks" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </li>
      </ul>
    </footer>
  );
}
