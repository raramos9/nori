import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json([
    { id: 'a1', message: 'Website relaunch moved to review', href: '/projects/p-100' },
    { id: 'a2', message: 'Mobile app has a new comment', href: '/projects/p-200' },
  ]);
}
