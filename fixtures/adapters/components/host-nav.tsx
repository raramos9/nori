import Link from 'next/link';
import type { ReactNode } from 'react';

export function HostNav({ children }: { children?: ReactNode }) {
  return (
    <nav>
      <Link href="/">Home</Link>
      {children}
      <Link href="/settings">Settings</Link>
    </nav>
  );
}
