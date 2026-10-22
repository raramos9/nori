import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findGuide } from '@/lib/guides';

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const found = findGuide(slug);
  if (found === null) notFound();
  const { guide, previous, next } = found;

  return (
    <article>
      <Link href="/docs">All guides</Link>
      <h1>{guide.title}</h1>
      <p>Everything you need to know about {guide.title.toLowerCase()}.</p>
      <footer>
        {previous && <Link href={`/docs/${previous.slug}`}>Previous: {previous.title}</Link>}
        {next && <Link href={`/docs/${next.slug}`}>Next: {next.title}</Link>}
      </footer>
      <p>
        Ready to try it? <Link href="/signup">Create a free account</Link>.
      </p>
    </article>
  );
}
