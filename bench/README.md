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
