# github-syncer

Reads one GitHub account's commit history via the API — commits on default
branches *and* the commits inside your pull requests — and rebuilds it as
backdated empty commits in a fresh local repo under a different author identity.
Push the result and the source account's activity — private repos included —
shows up on the destination account's contribution graph.

For consolidating your own activity (work account → personal profile). Not for
claiming work you didn't do.

## Use

    node github-syncer.ts

Needs Node 24+ (runs TypeScript directly) and git. No dependencies, no build step.
It asks for everything; most prompts have a default, so Enter works — except the
destination author name and email, which have no default and re-ask until answered
if `git config user.name`/`user.email` are unset.

Provide the source token via `GITHUB_TOKEN` to skip the token prompt. The token
needs `repo` scope to see private repositories.

At the end you choose whether to commit the replica immediately or write a
`replay.sh` script to run later — review it first, since it contains the full
replayed history as shell commands.

If a previous run's `commits.json` is present, you're offered a chance to reuse
it (with its commit count and date range shown) instead of re-hitting the API.

## Notes

- The destination email must be **verified on the destination account**, or the
  commits are attributed to nobody.
- GitHub counts commits on the default branch only, so the replica is built on `main`.
- Two sources are always fetched and merged, deduplicated by SHA. First every
  accessible repo's default branch. Then every pull request you authored, via
  `/pulls/{n}/commits` — which is the only way to recover the commits behind a
  **squash merge**, since squashing leaves one commit on the branch dated at
  merge time while your original commits and their real dates survive only on
  the PR. That endpoint still serves them after the PR branch is deleted.
  Commits by other people on a shared PR branch are filtered out.
- PR enumeration uses the search API, which caps at 1000 results and allows only
  30 requests per minute. Past that cap the tool warns and you narrow the date
  range; the rate limit just makes a large fetch slower.
- Commits on a non-default branch that never became a pull request are not
  collected. Neither are PRs opened, reviews, or issues — GitHub counts those as
  contributions but they are not commits, so no commit replica reproduces them.
  Expect the replica to undercount a squares-per-day comparison slightly.
- The REST API returns author dates in UTC and does not expose the original UTC
  offset. You pick one offset for the whole replay; commits authored in another
  timezone may land one calendar day off.
- GitHub's `since`/`until` range filters on **committer date**, but this tool
  replays **author date**. On rebased, cherry-picked, or imported history the two
  can diverge, so the requested date range is approximate for that history.
- `commits.json` is cached so re-runs don't re-hit the API. Delete it to force a
  refetch. It contains **private repository names** and is written to whatever
  directory you run the tool from — it may not be gitignored there, so don't
  commit it.
- Nothing is pushed for you.

## Test

    node --test test.ts
