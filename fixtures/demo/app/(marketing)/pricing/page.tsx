import Link from 'next/link';

const PLANS = [
  { name: 'Free', price: '$0', cta: { label: 'Get started', href: '/signup' } },
  { name: 'Team', price: '$12', cta: { label: 'Start a trial', href: '/signup?plan=team' } },
  { name: 'Enterprise', price: 'Custom', cta: { label: 'Contact sales', href: '/about#contact' } },
];

export const metadata = { title: 'Pricing' };

export default function PricingPage() {
  return (
    <section>
      <h1>Pricing</h1>
      <div className="plans">
        {PLANS.map((plan) => (
          <article key={plan.name}>
            <h2>{plan.name}</h2>
            <p className="price">{plan.price}</p>
            <Link href={plan.cta.href}>{plan.cta.label}</Link>
          </article>
        ))}
      </div>
      <p>
        <a href="#faq">Questions? Jump to the FAQ</a> or{' '}
        <a href="/pricing-sheet.pdf" download>
          download the pricing sheet
        </a>
        .
      </p>
      <h2 id="faq">Frequently asked questions</h2>
      <dl>
        <dt>Can I change plans later?</dt>
        <dd>Yes, from the billing page at any time.</dd>
      </dl>
    </section>
  );
}
