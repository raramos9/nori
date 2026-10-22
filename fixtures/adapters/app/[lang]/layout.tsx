import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';

export default async function MarketingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  return (
    <html lang={lang}>
      <body>
        <SiteHeader lang={lang} />
        <main>{children}</main>
      </body>
    </html>
  );
}
