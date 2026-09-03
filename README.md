# github-syncer

Reads one GitHub account's **contribution graph** via the GraphQL API and rebuilds
it as backdated empty commits in a fresh local repo under a different author
identity. If the source account shows 22 contributions on 1 September, the replica
gets 22 commits dated 1 September. Push it and the destination profile's graph
matches the source's, square for square.

For consolidating your own activity (work account → personal profile). Not for
claiming work you didn't do.

## Use

    node github-syncer.ts

Needs Node 24+ (runs TypeScript directly) and git. No dependencies, no build step.
It asks for everything; most prompts have a default, so Enter works — except the
destination author name and email, which have no default and re-ask until answered
if `git config user.name`/`user.email` are unset.

Provide the source token via `GITHUB_TOKEN` to skip the token prompt. The token
needs `read:user` for the calendar, and `repo` for contributions in private
repositories to be counted.

At the end you choose whether to commit the replica immediately or write a
`replay.sh` script to run later — review it first, since it contains the full
replayed history as shell commands.

If a previous run's `contributions.json` is present, you're offered a chance to
reuse it (with its total and date range shown) instead of re-hitting the API.

## Why the contribution graph, not the commit log

The graph counts more than commits: opening an issue, opening a pull request,
submitting a PR review, opening or answering a discussion, and creating or forking
a repository all count, per [GitHub's contributions
reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference).
Merging a PR is *not* a contribution in itself — it counts through the merge commit
and through having opened the PR.

Reconstructing that total by summing REST endpoints cannot work, and the near miss
is instructive: a commit counts only on a **default or `gh-pages` branch of a
non-fork** repo. So the individual commits behind a squash-merged PR were never on
the source graph at all — only the single squash commit was. Collecting them, which
an earlier version of this tool did, *over*-counts you.

The GraphQL contribution calendar is the graph itself, so it needs one query per
year and is right by construction:

```graphql
viewer { contributionsCollection(from: "…", to: "…") {
  contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } }
```

## Notes

- The destination email must be **verified on the destination account**, or the
  commits are attributed to nobody and the graph stays empty.
- GitHub counts commits on the default branch only, so the replica is built on `main`.
- A day's commits are spread evenly across 09:00–22:00 in the offset you choose, so
  a day with hundreds of contributions cannot spill past midnight onto the next
  square. Times of day are synthetic — the graph never showed them anyway.
- The calendar returns dates directly, so no timezone conversion can shift a
  contribution onto the wrong square. The offset you pick only decides what local
  time the commits carry.
- If `restrictedContributionsCount` comes back non-zero, contributions in private
  repositories were counted but not visible in detail to your token — give it
  `repo` scope. The tool prints that number.
- Compare the printed total against your real profile graph on the first run. If it
  looks low, the token is missing scope, or your profile has private contributions
  excluded.
- The replica contains only empty commits with messages like
  `contribution 2026-09-01#7`. Anyone reading it can tell what it is.
- `contributions.json` is cached so re-runs don't re-hit the API. Delete it to force
  a refetch. It's written to whatever directory you run the tool from.
- Nothing is pushed for you.

## Test

    node --test test.ts
