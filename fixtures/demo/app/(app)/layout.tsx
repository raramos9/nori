import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { getSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session === null) redirect('/login');

  return (
    <div className="app-shell">
      <AppSidebar name={session.name} />
      <main>{children}</main>
    </div>
  );
}
