import { cookies } from 'next/headers';

export type Session = { userId: string; name: string };

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const userId = store.get('uid')?.value;
  return userId === undefined ? null : { userId, name: store.get('name')?.value ?? 'You' };
}
