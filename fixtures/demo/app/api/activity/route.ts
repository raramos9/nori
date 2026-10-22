import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json([
    { id: 'a1', message: 'Apollo launch: 3 tasks completed', href: '/projects/apollo' },
    { id: 'a2', message: 'Your invoice for October is ready', href: '/settings/billing' },
  ]);
}
