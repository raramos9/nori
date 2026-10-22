import Link from 'next/link';

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  return (
    <section>
      <h1>Plan work, ship it</h1>
      <Link href={`/${lang}/blog`}>Read the blog</Link>
      <Link href="/blog/hello-world">Why we built Acme</Link>
    </section>
  );
}
