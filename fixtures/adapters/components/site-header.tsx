import Link from 'next/link';

export function SiteHeader({ lang }: { lang: string }) {
  return (
    <header>
      <Link href="/">Acme</Link>
      <nav>
        <Link href="/pricing">Pricing</Link>
        <Link href="/blog">Blog</Link>
        <Link href={`/${lang}/about`}>About</Link>
        <a href="https://app.acme.dev/projects">Open the app</a>
      </nav>
    </header>
  );
}
