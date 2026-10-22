import { NextResponse, type NextRequest } from 'next/server';

const LOCALES = ['en', 'de', 'fr'];
const DEFAULT_LOCALE = 'en';
const APP_HOSTS = new Set(['app.acme.dev', 'admin.acme.dev']);

export function middleware(request: NextRequest) {
  const host = (request.headers.get('host') ?? '').split(':')[0] ?? '';
  const { pathname } = request.nextUrl;
  const rest = pathname === '/' ? '' : pathname;
  const url = request.nextUrl.clone();

  if (APP_HOSTS.has(host)) {
    url.pathname = `/${host}${rest}`;
    return NextResponse.rewrite(url);
  }

  const [, first] = pathname.split('/');
  if (first !== undefined && LOCALES.includes(first)) return NextResponse.next();
  url.pathname = `/${DEFAULT_LOCALE}${rest}`;
  return NextResponse.rewrite(url);
}

export const config = { matcher: ['/((?!_next|api|.*\\..*).*)'] };
