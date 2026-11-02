# nori

nori turns a Next.js App Router repository into a map of its screens and the navigation between them. Every screen and link in the map points back to the line of code it came from. Navigation that can't be pinned down statically is labelled unresolved rather than guessed.

The map starts from a static read of the source. You can then back it with evidence. `nori verify` crawls the running app in an isolated browser and marks the links it walked as observed. `nori import` attaches a Playwright report, so a passing or failing test shows on the transitions it exercised. `nori diff` compares the maps of two commits.

You can read the map three ways. `nori scan` prints it, `nori explore` opens it as a graph in the browser, and `nori mcp` serves it to a coding agent.

Status: early and unpublished. It runs locally only, and there is no hosted version yet.

## Install

Build it from source with Node 22.2 or later and pnpm:

```sh
git clone https://github.com/raramos9/nori.git
cd nori
pnpm install
pnpm build
```

The CLI is `dist/cli.js`. The examples below assume an alias:

```sh
alias nori="node $PWD/dist/cli.js"
```

`nori verify` drives your installed Google Chrome, so install Chrome before you use it.

## Use

Run any command inside a Next.js App Router project, or pass its path. The project must be a git work tree, and a `package.json` in it (or above it in the same repository) must list `next`. To try nori without your own app, point any command at `fixtures/demo`, a small app included in this repository.

### Map the source

```sh
nori scan path/to/app
```

This prints the build, every route, and how many navigation calls resolved to a screen.

### Crawl the running app

Start the app's dev server yourself, then point nori at it:

```sh
nori verify path/to/app --url http://localhost:3000
```

nori follows links from the app's screens and records a screenshot and the HTML of every page it reaches. Each transition it walks becomes `observed`. One that the static map predicted but the crawl contradicted becomes `failed`.

The browser stays inside the origin you pass. It sends only read requests, so a crawl cannot submit forms or change data. Some options widen what it sees:

- `--storage-state signed-in=state.json` crawls again with a saved Playwright storage state, for example a logged-in session. Repeat it for several sessions. Pass `--no-anonymous` to skip the logged-out crawl.
- `--interactions file.json` names forms to fill and buttons to click, and the exact write requests each may send (`"allow": ["POST /api/session"]`). Nothing else may write.
- `--max-captures`, `--max-navigations` and `--max-seconds` cap a crawl.

The crawl is tied to the commit and source it ran against. If you edit the source mid-crawl, nori reports it and exits with status 1.

### Attach Playwright results

```sh
npx playwright test --reporter=json > report.json
nori import report.json path/to/app
```

Each test is linked to its report entry and trace, and to the transitions its steps walked. A failing test shows on the transition it failed on, not on the whole screen. A test whose trace is missing still imports, marked trace-less. Test evidence is counted on its own. A passing test does not make a transition `observed`, only a crawl does.

### Compare two commits

```sh
nori diff main HEAD path/to/app
```

This checks out both commits into temporary worktrees, so your uncommitted changes are left out. It reports screens and transitions that were added or removed, ones a crawl saw on one side only, and pages whose screenshot changed. Anything only one side crawled is listed as a coverage gap, with the reason it can't be compared. `--markdown` renders the diff as a PR comment, and `--json` prints it whole.

To get the runtime changes too, run `nori verify` on a clean checkout of each commit first. A crawl of a working tree with uncommitted changes belongs to that dirty tree, not to the commit. Without crawls, the diff covers the static map only.

### Comment the diff on a pull request

`action/` holds a GitHub Action that posts this diff as one PR comment and edits it in place on later pushes. See [action/README.md](action/README.md). `nori comment <markdown-file>` is the step that does the posting.

### Explore the map

```sh
nori explore path/to/app
```

This opens the map in your browser. Click a screen to focus it with its neighbours, follow its links in the side panel, see its screenshots and tests, and expand any source reference to see the code. A coverage block counts transitions that are inferred, observed, and exercised by a passing test. Pass `--no-open` to only print the URL, or `--port <n>` to choose the port. It serves on 127.0.0.1 only.

### Give the map to an agent

```sh
claude mcp add nori -- node /path/to/nori/dist/cli.js mcp /path/to/app
```

This gives Claude Code five read-only tools:

- `list_screens` lists the screens with their status and screenshots, plus the coverage counts.
- `get_screen` returns a screen's transitions in and out, its captures, and which sessions walked them.
- `read_source` shows the code behind any screen or transition.
- `list_builds` lists the commits nori has analysed for this app.
- `diff_builds` compares two of them, the same diff `nori diff` prints.

The server re-analyses when the source changes, so the agent always sees the current code. Any MCP client that runs stdio servers works the same way.

## What to expect

- A screen or transition starts as `inferred`. Static analysis proposed it and nothing has confirmed it yet. A crawl moves it to `observed` or `failed`.
- Roughly a third of internal navigation stays unresolved. Common causes are a target computed at runtime, such as `router.push(next)`, or a link built from data. Each unresolved call keeps its source expression, so you can see why.
- On six open-source apps that were held out from tuning, 61.6% of internal navigation calls resolve to a screen. `bench/` has the benchmark and how to rerun it.
- A link inside a shared layout or component counts as navigation from every screen that renders it.
- A diff says what changed, not which commit caused a failure. nori makes no causal claims.
- nori keeps its state under `~/.nori/stores/<app key>/` (override with `NORI_HOME`), including the database and every crawl's screenshots. It writes nothing into the analysed project. Two checkouts of one repository share a store, so a diff can compare builds made in different directories.

## Develop

```sh
pnpm typecheck
pnpm test
```

For the explorer UI with hot reload, run `nori explore <app> --no-open --port 4310` in one terminal and `pnpm dev` in another. Vite proxies `/api` to that port.

`fixtures/demo/expected.json` is the ground truth for the demo app, and `src/fixtures.test.ts` checks nori against it.
