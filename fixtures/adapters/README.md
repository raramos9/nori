# Adapters fixture

A small Next.js App Router app ("Acme") served from three hosts. `middleware.ts` rewrites `app.acme.dev` and `admin.acme.dev` to `/<host>/<path>` and every other host to `/<lang>/<path>` (default `en`). That rewrite is the ground truth: on the app host a link to `/settings` opens `app/app.acme.dev/settings`, and on the marketing site `/pricing` opens `app/[lang]/pricing`.

It exercises the three FR-1 adapters:

- **locale**: marketing links without a prefix (`/pricing`, `/blog/hello-world`) and with one (`/${lang}/about`) both reach `app/[lang]/...`.
- **host**: `app.acme.dev` and `admin.acme.dev` both have `/`, `/settings` and a shared `HostNav`, so a link resolves only against the host of the screen that renders it.
- **builder**: `href('/projects/[id]', { id })` comes from `lib/routes.ts`, whose body calls an unresolvable package. Only the bracketed literal names the target.

```sh
nori explore fixtures/adapters
```

`expected.json` has the same shape as the demo's, written from the app's runtime behavior before nori ran on it. `adapterEdges` adds the edges that resolve only because of one adapter, each tagged `host`, `locale` or `builder`; `src/fixtures.test.ts` checks that each is resolved with adapters on and absent with them off. A pair that raw matching also produces for the wrong link isn't listed: every marketing screen's `/ -> /[lang]` is one, because raw matching reads `/pricing` as `lang=pricing`.

| Measure | Value |
| --- | --- |
| Screens | 12 of 12 (route recall 100%) |
| True edges | 46 |
| Resolved by nori | 45 |
| Transition precision | 45 / 45 (100%) |
| Edge recall | 45 / 46 (97.8%) |

The one missed edge is `/app.acme.dev -> /app.acme.dev/projects/[id]`. The activity feed links to `item.href`, which comes from a fetch. The `returnTo` push on `/app.acme.dev/settings` is open, since a query parameter can name any path.

The fixture found two matcher bugs before these numbers held. A link to `/` on a host screen resolved to the hostless `/[lang]`, fixed in 74f6b8d. `/${lang}/about` resolved to `/[lang]/blog/[slug]`, fixed in 4f94c4a.
