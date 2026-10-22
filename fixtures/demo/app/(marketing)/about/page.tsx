import Link from 'next/link';

export const metadata = { title: 'About' };

export default function AboutPage() {
  return (
    <section>
      <h1>About Tasks</h1>
      <p>We are a small remote team building calmer project software.</p>
      <p>
        Follow along on{' '}
        <a href="https://x.com/tasksapp" rel="noreferrer">
          X
        </a>
        , or <Link href="/docs">read how it works</Link>.
      </p>
      <h2 id="contact">Contact</h2>
      <p>Write to hello@tasks.example and we will get back to you within a day.</p>
    </section>
  );
}
