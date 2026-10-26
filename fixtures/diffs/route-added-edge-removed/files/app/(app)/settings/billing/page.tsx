import Link from 'next/link';

export const metadata = { title: 'Billing' };

export default function BillingPage() {
  return (
    <>
      <Link href="/settings">Back to settings</Link>
      <h1>Billing</h1>
      <p>You are on the Free plan.</p>
    </>
  );
}
