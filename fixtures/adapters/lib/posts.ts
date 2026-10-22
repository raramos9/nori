export type Post = { slug: string; title: string };

export const POSTS: readonly Post[] = [
  { slug: 'hello-world', title: 'Hello, world' },
  { slug: 'shipping-weekly', title: 'Shipping weekly' },
  { slug: 'pricing-changes', title: 'Pricing changes' },
];

export function findPost(slug: string): Post | null {
  return POSTS.find((post) => post.slug === slug) ?? null;
}
