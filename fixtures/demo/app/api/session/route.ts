import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  const store = await cookies();
  store.set('uid', 'u1');
  store.set('name', email);
  return Response.json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete('uid');
  store.delete('name');
  return Response.json({ ok: true });
}
