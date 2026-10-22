# Benchmark

`held-out.json` pins the held-out App Router apps that score the edge-resolution target (PRD §11). They were picked from repository metadata and file paths only. Don't read their source, their unresolved calls, or their per-call rows while writing or changing adapters. Report only per-app and total rates for this set.

`tuning.json` pins the 19 probe apps the adapters were written against. Both files have the same shape. Each app is a repo, a full commit sha, and a root inside the checkout.

## Running

```
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsx bench/run.ts
```

The larger apps (dify, cal.com) need the bigger heap. Checkouts are shallow fetches of the pinned commit under `~/.cache/nori/bench`. An existing checkout at the right commit is reused. One at another commit is an error, and nothing is deleted for you.

- `--set tuning|held-out|all` picks the set. The default is `all`.
- `--cache <dir>` moves the checkout cache.
- `--only <text>` keeps apps whose `repo/root` contains the text. It can repeat.
- `--rows <file>` writes one row per navigation call from the adapters-on run. It is refused with exit 2 when any held-out app is selected.

Progress goes to stderr and the report goes to stdout. The exit code is 0 whatever the rates are.

## Columns

Each app is analyzed twice. `raw` has the three framework adapters off. `adapters` has them on. The adapters are hostname folders, the optional locale segment, and route-builder patterns.

A cell reads `rate (resolved/internal)`. Internal calls are links and navigations that are not external, same-page, asset, or handler targets. A call counts as resolved only when it resolves from every screen that reaches it. The total row pools calls across apps. The median line is the median of per-app rates.

The held-out report ends with two verdicts against §11. The raw total must reach 50% and the adapters total must reach 60%. A gap between the tuning and held-out rates is the sign of overfitting.

## Precision sample

The rate counts how many calls resolve, not whether they resolve to the right screen. `precision.ts` draws a seeded sample of resolved edges from the tuning apps for hand labelling:

```
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsx bench/precision.ts --out sample.json [--size 100] [--seed 1]
```

`--score <labelled.json>` re-scores a labelled sample against the current analyzer instead of drawing a new one. It analyzes only the apps in the sample, then prints how many labelled edges still exist, the precision over the surviving decided edges, and the surviving and vanished edges by cause:

```
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsx bench/precision.ts --score bench/precision/seed1.json
```

An edge is one source screen, one call site and one target screen, so a link in a shared layout counts once per screen it renders on. Each row has a stable `id`, the source and target patterns, the trigger, and the call's file, line and code. Only tuning apps are sampled; the held-out set stays unread.

`precision/seed1.json` is the first labelled sample (100 edges, seed 1, labelled 2026-10-22). Each edge carries a `verdict` (`correct`, `wrong-source`, `wrong-target`, `unclear`) with the evidence, and wrong edges carry a `cause`. The judges first reported 60 of 98 correct; four of those edges start or end on a page that only redirects, so the corrected baseline is 56 of 98 (57%). After redirect-only pages became pass-throughs, 10 sampled edges disappeared and 56 of the remaining 88 decided edges are correct (64%). Reach now skips lazy-import tables and follows the names a screen uses rather than whole files; 82 sampled edges survive and 55 of the 80 decided ones are correct (68.8%). The one correct edge lost came from an mdx file naming a registry demo, which nori cannot see. A hole that fits only by landing in a catch-all is now ambiguous when a dynamic segment could take it instead; 81 sampled edges survive and 55 of the 79 decided ones are correct (69.6%).

| Cause | Edges | Fixable from source |
| --- | --- | --- |
| `runtime-guard`: the call only runs under state the screen never has | 15 | No |
| `redirect-only-page`: the source or target page only calls `redirect()` | 12 | Yes; 8 fixed, 4 inbox-zero pages redirect through a helper |
| `import-over-attribution`: a server-action file or lazy registry credits every importer | 7 | Yes; all 7 fixed |
| `per-screen-prop`: a prop set differently per screen switches the call or its value | 4 | Hard |
| `hole-into-catch-all`: a mostly unknown path lands on a root catch-all | 3 | Yes; all 3 fixed |
| `both-branches`: the screen fixes which branch of a conditional runs | 1 | Hard |

`precision/seed2.json` is a fresh sample drawn after those fixes (100 edges, seed 2, labelled 2026-10-22, no overlap with seed1). Two judges on different models labelled every edge independently and agreed on 96; the other 4 were settled against the source and say so in `why`. 64 of 100 are correct (64%, about ±9 points at 95%). Seed1 scores higher because the fixes were chosen from its errors; pooled over both samples, 119 of 179 decided edges are correct (66%).

| Cause | Edges | Fixable from source |
| --- | --- | --- |
| `runtime-guard` | 16 | No |
| `redirect-only-page` | 10 | Yes. 7 are inbox-zero's `prefixPath(id, "/x")` fallback branch landing on a bare `/x` page that redirects through a helper; the rest are a client `router.replace` in an effect and a redirect to an external URL |
| `per-screen-prop` | 5 | Hard |
| `both-branches` | 3 | Hard |
| `import-over-attribution` | 1 | Yes |
| `item-branch`: a literal list feeds two branches and every item is credited to both | 1 | Yes |
