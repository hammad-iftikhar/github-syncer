# github-syncer

Reads one GitHub account's commit history via the API and rebuilds it as
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
