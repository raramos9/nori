import Link from 'next/link';
import type { ReactNode } from 'react';
import { HostNav } from '@/components/host-nav';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HostNav>
          <Link href="/users">Users</Link>
        </HostNav>
        <a href="https://app.acme.dev">Back to the app</a>
        <main>{children}</main>
      </body>
    </html>
  );
}
