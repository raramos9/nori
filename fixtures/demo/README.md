# Demo fixture

A small Next.js App Router app ("Tasks", a project tracker) with a marketing site, auth pages and a signed-in area. It is nori's M1 ground-truth fixture and a demo to open in the explorer:

```sh
nori explore fixtures/demo
```

To run the app itself, `npm install` then `npm run dev` in this directory. `POST /api/session` signs in by setting the `uid` and `name` cookies, and `DELETE` signs out.

`expected.json` lists every screen and every navigation a user can follow at runtime, written from the app's behavior before nori ran on it. `missed` is the subset static analysis can't resolve, each with a reason. `open` lists screens with a call whose targets can't be named at all, such as a redirect to a query parameter. `src/fixtures.test.ts` checks nori against it.

| Measure | Value |
| --- | --- |
| Screens | 14 of 14 (route recall 100%) |
| True edges | 79 |
| Resolved by nori | 78 |
| Transition precision | 78 / 78 (100%) |
| Edge recall | 78 / 79 (98.7%) |

`/home` only redirects to `/dashboard`, so the header's "Open app" link is an edge to `/dashboard`, and `/home` shows none of the signed-in layout's links.

The one missed edge is `/dashboard -> /settings/billing`: the activity feed links to `item.href`, which comes from a fetch.

The app was written to exercise each kind of navigation call, not to be typical, so these rates are a correctness check. The edge-resolution rate on real apps comes from `bench/run.ts`.
