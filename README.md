# github-syncer

Reads one GitHub account's **contribution graph** via the GraphQL API and rebuilds it
as backdated empty commits under a different author identity. If the source account
shows 22 contributions on 1 September, the replica gets 22 commits dated 1 September.
Push it and the destination profile's graph matches the source's, square for square.

For consolidating your own activity (work account → personal profile). Not for
claiming work you didn't do.

## Use

    node github-syncer.ts

Needs Node 24+, which runs TypeScript directly, and git. No runtime dependencies and
no build step — `@types/node` is a dev-only type package, and `node_modules/` is never
needed to run the tool. `npm start` and `npm test` are aliases for the two commands
in this file.

It asks for everything, in this order:

| Prompt | Default |
|---|---|
| Reuse `contributions.json`? *(only if a cache is there)* | yes |
| Source GitHub token *(skipped if the cache is reused)* | `$GITHUB_TOKEN`, else typed with echo muted |
| Since / Until date | one year ago / today |
| Timezone offset to stamp the commits with | your machine's |
| Destination author name / email | `git config user.name` / `user.email` |
| Commit now, or only write `replay.sh`? | commit now |
| Output directory *(only when committing now)* | `./replica` |
| Proceed? | **no** |

Every prompt takes its default on a bare Enter. The two exceptions are the author name
and email: if `git config user.name`/`user.email` are unset they have no default and
re-ask until answered, because a commit with an empty author is one git won't attribute.

The token needs `read:user` for the calendar, and `repo` for contributions in private
repositories to be counted. Reusing a cached fetch needs no token at all, which is why
that question comes first.

Before anything is written you get a summary, and it's the only prompt that defaults to
no:

```
--- summary ---
contributions: 2152  (one empty commit each)
active days:   413
range:         2023-05-10 .. 2026-09-03
busiest day:   2024-11-19 (37)
identity:      Me <me@example.com>
target:        ./replica
---------------

Proceed? (y/n) [n]:
```

## replay.sh

Answering **n** to "Commit now?" writes `replay.sh` instead of committing. Review it
first — it contains the whole replayed history as shell commands.

The script names no directory. It commits into whatever directory you run it from:

    mkdir replica && cd replica && bash ../replay.sh

It runs `git init -q -b main` only if the directory isn't already a repository, so you
can equally run it inside a repo you made earlier and it will append to what's there.
Two things follow from that:

- **Run it once.** There is no re-run protection, so running it twice in the same place
  gives you two copies of the history, silently.
- If you run it in an existing repo that's on some other branch, the commits go to that
  branch. GitHub only counts the default branch, so make sure that's where they land.

## Why the contribution graph, not the commit log

The graph counts more than commits: opening an issue, opening a pull request,
submitting a PR review, opening or answering a discussion, and creating or forking a
repository all count, per [GitHub's contributions
reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference).
Merging a PR is *not* a contribution in itself — it counts through the merge commit and
through having opened the PR.

Reconstructing that total by summing REST endpoints cannot work, and the near miss is
instructive: a commit counts only on a **default or `gh-pages` branch of a non-fork**
repo. So the individual commits behind a squash-merged PR were never on the source graph
at all — only the single squash commit was. Collecting them, which an earlier version of
this tool did, *over*-counts you.

The GraphQL contribution calendar is the graph itself, so it is right by construction
and costs one query per year rather than one per repository:

```graphql
viewer {
  login
  contributionsCollection(from: "…", to: "…") {
    restrictedContributionsCount
    contributionCalendar {
      totalContributions
      weeks { contributionDays { date contributionCount } }
    }
  }
}
```

## Notes

- The destination email must be **verified on the destination account**, or the commits
  are attributed to nobody and the graph stays empty.
- **Check the printed total against your real profile graph on your first run.** If it
  looks low, the token is missing `repo` scope, or your profile excludes private
  contributions.
- The tool may report that some contributions are "restricted". That means they were
  made in private repositories your token cannot see — *not* that they are inside the
  total above. It's the usual reason a total comes back low; add `repo` scope and
  refetch. The number is approximate, since the fetch windows overlap slightly.
- Conversely, with `repo` scope the calendar counts private contributions that your
  *public* source profile may be hiding. The replica's graph can therefore legitimately
  show **more** than the source profile shows a visitor.
- A day's commits are spread evenly across 09:00–22:00 in the offset you choose, so a
  day with hundreds of contributions cannot spill past midnight onto the next square.
  Times of day are synthetic — the graph never showed them.
- The calendar returns dates directly, so no timezone conversion can move a
  contribution onto the wrong square. The offset only decides what local time the
  commits carry.
- The replica holds nothing but empty commits, with messages like
  `contribution 2026-09-01#7`. Anyone reading it can tell exactly what it is.
- `contributions.json` caches the fetch so re-runs don't hit the API. It records which
  account and date range it came from, and the reuse prompt shows that login, so a cache
  from another account can't be accepted by accident. Delete it to force a refetch. It
  lands in whatever directory you run the tool from.
- The replay spawns one `git` process per commit, so a busy decade (20k+ contributions)
  takes minutes and prints a counter every 100. That's the slow part, not the fetch.
- Nothing is pushed for you. The tool prints the `git remote add` and `git push` lines
  and stops.

## Test

    node --test test.ts
