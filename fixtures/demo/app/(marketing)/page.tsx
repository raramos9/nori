import Link from 'next/link';

const FEATURES = [
  { title: 'Projects', body: 'Group tasks by project and see progress at a glance.' },
  { title: 'Timelines', body: 'Drag work across a shared timeline.' },
  { title: 'Reports', body: 'Weekly summaries land in your inbox.' },
];

export default function HomePage() {
  return (
    <section className="hero">
      <h1>Ship work, not status meetings.</h1>
      <p>Tasks keeps every project, owner and deadline in one place.</p>
      <div className="cta">
        <Link href="/signup" className="button">
          Start free
        </Link>
        <Link href="/pricing">See pricing</Link>
        <Link href="/docs/getting-started/quickstart">Read the quickstart</Link>
      </div>
      <ul className="features">
        {FEATURES.map((feature) => (
          <li key={feature.title}>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
