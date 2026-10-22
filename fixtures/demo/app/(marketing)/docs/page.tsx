import Link from 'next/link';
import { GUIDES } from '@/lib/guides';

export const metadata = { title: 'Documentation' };

export default function DocsIndexPage() {
  return (
    <section>
      <h1>Documentation</h1>
      <ul>
        {GUIDES.map((guide) => (
          <li key={guide.slug}>
            <Link href={`/docs/${guide.slug}`}>{guide.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
