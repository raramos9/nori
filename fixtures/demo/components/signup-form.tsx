'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function SignupForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const response = await fetch('/api/account', { method: 'POST', body: new FormData(event.currentTarget) });
    const account: { inviteUrl: string | null } = await response.json();
    router.replace(account.inviteUrl === null ? '/projects/new' : account.inviteUrl);
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Work email
        <input name="email" type="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" minLength={12} required />
      </label>
      <button type="submit" disabled={pending}>
        Create account
      </button>
      <p>
        Already registered? <Link href="/login">Log in</Link>
      </p>
    </form>
  );
}
