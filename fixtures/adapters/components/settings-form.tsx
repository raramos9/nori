'use client';

import { useRouter } from 'next/navigation';

export function SettingsForm() {
  const router = useRouter();

  function save() {
    const returnTo = new URLSearchParams(window.location.search).get('returnTo');
    if (returnTo) router.push(returnTo);
  }

  return <button onClick={save}>Save</button>;
}
