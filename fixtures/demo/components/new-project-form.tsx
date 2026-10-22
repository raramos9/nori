'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

export function NewProjectForm() {
  const router = useRouter();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch('/api/projects', { method: 'POST', body: new FormData(event.currentTarget) });
    const project: { id: string } = await response.json();
    router.push(`/projects/${project.id}`);
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Project name
        <input name="name" required />
      </label>
      <button type="submit">Create project</button>
      <Link href="/projects">Cancel</Link>
    </form>
  );
}
