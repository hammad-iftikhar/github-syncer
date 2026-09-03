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
It asks for everything; every prompt has a default, so Enter works.

Provide the source token via `GITHUB_TOKEN` to skip the token prompt. The token
needs `repo` scope to see private repositories.

## Notes

- The destination email must be **verified on the destination account**, or the
  commits are attributed to nobody.
- GitHub counts commits on the default branch only, so the replica is built on `main`.
- The REST API returns author dates in UTC and does not expose the original UTC
  offset. You pick one offset for the whole replay; commits authored in another
  timezone may land one calendar day off.
- `commits.json` is cached so re-runs don't re-hit the API. Delete it to force a refetch.
- Nothing is pushed for you.

## Test

    node --test test.ts
