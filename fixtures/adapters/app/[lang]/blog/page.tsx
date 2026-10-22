import Link from 'next/link';
import { POSTS } from '@/lib/posts';

export default function BlogPage() {
  return (
    <section>
      <h1>Blog</h1>
      <ul>
        {POSTS.map((post) => (
          <li key={post.slug}>
            <Link href={`/blog/${post.slug}`}>{post.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
