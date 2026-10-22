import Link from 'next/link';

export const metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <h1>Settings</h1>
      <ul>
        <li>
          <Link href="/settings/billing">Billing and invoices</Link>
        </li>
        <li>
          <a href="/api/export">Export your data</a>
        </li>
      </ul>
    </>
  );
}
