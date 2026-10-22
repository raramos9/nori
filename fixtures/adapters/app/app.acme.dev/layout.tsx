import Link from 'next/link';
import type { ReactNode } from 'react';
import { HostNav } from '@/components/host-nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HostNav>
          <Link href="/projects">Projects</Link>
        </HostNav>
        <main>{children}</main>
      </body>
    </html>
  );
}
