# nori diff action

Posts the `nori diff --markdown` of a pull request's base and head as one PR comment. A later push edits that comment in place. The same diff goes to the job summary.

```yaml
name: nori
on: pull_request

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: nori-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: raramos9/nori/action@main
        with:
          path: .
```

Inputs:

- `path`: the app directory, relative to the repository root. Defaults to `.`.
- `github-token`: defaults to the job's `github.token`.

The action builds nori from its own checkout, so it adds a minute or so to the job. A default depth-1 `actions/checkout` is enough, because the action fetches the two commits it compares.

## Security

The workflow uses `pull_request`, not `pull_request_target`, so the pull request's code never runs with a write token. nori reads the PR's files as data and does not execute them.

Fork PRs get a read-only token under `pull_request`. For those, the diff appears in the job summary, the step prints a warning, and no comment is posted.

Pin `@main` to a commit SHA if you do not want to track nori's default branch.
