# nori

nori turns a Next.js App Router repository into a map of its screens and the navigation between them. It reads the source without running the app or its tests. Every screen and link in the map points back to the line of code it came from, and navigation that can't be pinned down statically is labelled unresolved rather than guessed.

You can read the map three ways. `nori scan` prints it, `nori explore` opens it as a graph in the browser, and `nori mcp` serves it to a coding agent.

Status: early. Only static analysis exists so far. Later milestones add evidence from browser exploration and Playwright runs, plus diffs between builds.

## Install

nori isn't published yet. Build it from source with Node 22 or later and pnpm:

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

## Use

Run any command inside a Next.js App Router project, or pass its path. The project must be a git work tree, and a `package.json` in it (or above it in the same repository) must list `next`.

```sh
nori scan path/to/app
```

This prints the build, every route, and how many navigation calls resolved to a screen.

```sh
nori explore path/to/app
```

This opens the map in your browser. Click a screen to focus it with its neighbours, follow its outgoing links in the side panel, and expand any source reference to see the code. Pass `--no-open` to only print the URL, or `--port <n>` to choose the port. It serves on 127.0.0.1 only.

```sh
claude mcp add nori -- node /path/to/nori/dist/cli.js mcp /path/to/app
```

This gives Claude Code three read-only tools. `list_screens` lists the screens, `get_screen` returns a screen's transitions in and out, and `read_source` shows the code behind any of them. The server re-analyses when the source changes, so the agent always sees the current code. Any MCP client that runs stdio servers works the same way.

To try it without your own app, point any command at `fixtures/demo`, a small app included in this repository.

## What to expect

- Every screen and edge is labelled `inferred`. Static analysis proposes them, and nothing has been observed in a running app yet.
- Roughly a third of internal navigation stays unresolved. Common causes are a target computed at runtime, such as `router.push(next)`, or a link built from data. Each unresolved call keeps its source expression, so you can see why.
- On six open-source apps that were held out from tuning, 61.6% of internal navigation calls resolve to a screen. `bench/` has the benchmark and how to rerun it.
- A link inside a shared layout or component counts as navigation from every screen that renders it.
- nori writes its database to `.nori/graph.db` inside the analysed project. The directory ignores itself in git.

## Develop

```sh
pnpm typecheck
pnpm test
```

For the explorer UI with hot reload, run `nori explore <app> --no-open --port 4310` in one terminal and `pnpm dev` in another. Vite proxies `/api` to that port.

`fixtures/demo/expected.json` is the ground truth for the demo app, and `src/fixtures.test.ts` checks nori against it.
