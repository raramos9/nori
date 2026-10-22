import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findPost } from '@/lib/posts';

export default async function PostPage({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const post = findPost(slug);
  if (post === null) notFound();

  return (
    <article>
      <Link href={`/${lang}/blog`}>All posts</Link>
      <h1>{post.title}</h1>
    </article>
  );
}
