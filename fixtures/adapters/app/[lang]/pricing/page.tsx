import Link from 'next/link';

export default function PricingPage() {
  return (
    <section>
      <h1>Pricing</h1>
      <Link href="/about">Talk to us</Link>
      <a href="https://app.acme.dev/projects">Start for free</a>
    </section>
  );
}
