'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch('/api/session', { method: 'POST', body: new FormData(event.currentTarget) });
    if (!response.ok) {
      setError('Wrong email or password.');
      return;
    }
    router.push(searchParams.get('next') ?? '/dashboard');
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" required />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">Log in</button>
      <p>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </form>
  );
}
