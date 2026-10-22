import Link from 'next/link';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <Link href="/" className="logo">
        Tasks
      </Link>
      <main>{children}</main>
    </div>
  );
}
