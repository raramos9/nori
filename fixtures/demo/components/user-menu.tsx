'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function UserMenu({ name }: { name: string }) {
  const router = useRouter();

  async function signOut() {
    await fetch('/api/session', { method: 'DELETE' });
    router.replace('/login');
  }

  return (
    <div className="user-menu">
      <Link href="/settings">{name}</Link>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
