'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Activity = { id: string; message: string; href: string };

export function ActivityFeed() {
  const [items, setItems] = useState<Activity[]>([]);

  useEffect(() => {
    fetch('/api/activity')
      .then((response) => response.json())
      .then(setItems);
  }, []);

  return (
    <ul className="activity">
      {items.map((item) => (
        <li key={item.id}>
          <Link href={item.href}>{item.message}</Link>
        </li>
      ))}
    </ul>
  );
}
