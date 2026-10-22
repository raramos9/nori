import Link from 'next/link';

const NAV = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'About', href: '/about' },
  { label: 'Docs', href: '/docs' },
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="logo">
        Tasks
      </Link>
      <nav>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="actions">
        <Link href="/login">Log in</Link>
        <Link href="/signup" className="button">
          Sign up
        </Link>
      </div>
    </header>
  );
}
