# github-syncer — design

**Date:** 2026-09-03
**Status:** approved (revised — see History)

## Purpose

Read the contribution graph of a GitHub account via the GraphQL API, then rebuild
it as backdated empty commits in a fresh local git repo attributed to a different
account. One empty commit per counted contribution, on the day it was counted.
Pushing the replica makes the destination account's contribution graph match the
source's, square for square.

Intended use is a single person consolidating their own activity: a work account as
source, a personal profile as destination. It is not a tool for claiming work you
did not do.

## Non-goals

- Copying code, diffs, branches, or commit messages. Commits are empty.
- Reproducing per-commit times of day. The graph never displayed them.
- Pushing. The tool prints the `git remote add` / `git push` commands and stops.
- Creating the destination repo via API.
- Any non-interactive interface: no CLI flags, no config file.
- Resuming a partially-completed replay.

## Why the graph, not the commit log

Per GitHub's contributions reference, the graph counts commits, opening an issue,
proposing a pull request, submitting a pull request review, opening or answering a
discussion, and creating or forking a repository. Merging a pull request is not
itself a contribution: it counts through the merge commit and through the PR having
been opened.

A commit counts only when its author email is linked to the account, it sits on a
default or `gh-pages` branch, and the repository is not a fork. That last condition
is why summing REST endpoints cannot reproduce the graph: the individual commits
behind a squash-merged pull request never appeared on the source graph, because
squashing leaves only one commit on the default branch. Collecting them over-counts
the user.

`contributionsCollection.contributionCalendar` returns the graph's own daily
numbers, so it is correct by construction and costs one query per year rather than
one per repository.

## Runtime

Single file `github-syncer.ts`, run as `node github-syncer.ts`. Node 24 strips
TypeScript types natively, so there is no build step and no `tsconfig.json` is
required to run. Zero dependencies: global `fetch`, `node:readline/promises`,
`node:child_process`, `node:fs`, `node:path`, `node:process`.

## Interaction

Nine prompts, asked in order. Every prompt accepts its default on a bare Enter.

| # | Prompt | Default |
|---|--------|---------|
| 1 | Source GitHub token | `$GITHUB_TOKEN` if set; otherwise prompt with terminal echo muted |
| 2 | Since date (`YYYY-MM-DD`) | one year before today |
| 3 | Until date (`YYYY-MM-DD`) | today |
| 4 | Timezone offset to stamp commits with | the machine's current UTC offset |
| 5 | Destination author name | `git config user.name` |
| 6 | Destination author email | `git config user.email` |
| 7 | Output directory | `./replica` |
| 8 | Commit now, or only write `replay.sh`? | commit now |
| 9 | Summary, then proceed? | **no** |

Prompt 6 prints a warning that the email must be a *verified* email on the
destination account, or GitHub attributes the commits to no one and the
contribution graph stays empty.

Prompt 9 prints the contribution total, the number of active days, the date range,
the busiest day, the destination identity, and the output path before anything is
written to the output directory or to `replay.sh`. It is the only prompt that
defaults to no. `contributions.json` is the exception: it is deliberately written
earlier, as a cache, so an aborted run does not have to re-fetch.

Dates are validated as `YYYY-MM-DD` and re-asked on bad input; the offset as
`±HH:MM`. Name, email, and directory reject empty values, since an empty author
identity produces commits git will not attribute.

The existing-directory check runs immediately after prompt 7, before the summary,
so a run that will be refused is refused before the user confirms it.

## Fetching the calendar

`GITHUB_TOKEN` or the prompt supplies the token. The token needs `read:user`, and
`repo` for private-repository contributions to be counted.

1. The requested range is split into windows of at most 364 days, since
   `contributionsCollection` accepts at most one year per query. Windows are
   contiguous: each begins one second after the previous ends.
2. Each window is one POST to `https://api.github.com/graphql` requesting
   `viewer { login, contributionsCollection { restrictedContributionsCount,
   contributionCalendar { totalContributions, weeks { contributionDays { date,
   contributionCount } } } } }`.
3. Days with a zero count are dropped, as are dates outside the requested range —
   the calendar is week-aligned and so overhangs both ends.
4. A date appearing in two adjacent windows is taken once, not summed: the count is
   a property of the day, not of the window. Adding them would inflate the replica.
5. Days are returned sorted ascending by date.

`restrictedContributionsCount` is reported when non-zero, since it means
contributions were counted in private repositories the token cannot see in detail —
usually a missing `repo` scope.

### Error handling

GraphQL reports failures inside a 200 response body, so an unchecked `errors` array
would read as "no contributions" — the silent wrongness this tool can least afford.
Both a non-ok status and a non-empty `errors` array throw with the message.

Rate limiting needs no special handling: a decade of history is ten queries.

### contributions.json

```json
[{ "date": "2026-09-01", "count": 22 }]
```

If the file exists, the tool reports its total, its date range and its modification
time, and asks whether to reuse it instead of calling the API.

## Synthesising commits

Each day of count *N* becomes *N* entries. Entry *i* is placed at minute
`9*60 + floor(i * 13*60 / N)` of that date in the chosen offset — evenly spread
across 09:00–22:00 local, so even a day holding hundreds of contributions cannot
spill past midnight onto the next square. Beyond about 780 in one day the minutes
repeat, which git accepts.

An entry stores the **UTC instant** whose local time in the chosen offset is that
minute of that date. Replay then converts it back with the same offset, so the
commit lands on exactly the intended calendar day. The stored form is UTC purely so
that the replay path is identical to reading a UTC timestamp from an API.

Because the calendar supplies dates directly, no timezone conversion can move a
contribution onto the wrong square. The offset decides only what local time the
commits carry — which is why it is no longer described as "the zone you did the work
in".

Entry ids are `YYYY-MM-DD#i`, which become commit messages of the form
`contribution 2026-09-01#7`. The replica is not disguised.

## Replay

Refuse to proceed if the output directory already exists, rather than appending a
second copy of the history. Report the path and exit.

```
git init -q -b main -- <outdir>
```

Then, per entry, in date order:

```
GIT_AUTHOR_NAME=<name>  GIT_AUTHOR_EMAIL=<email>  GIT_AUTHOR_DATE=<iso+offset>
GIT_COMMITTER_NAME=<name> GIT_COMMITTER_EMAIL=<email> GIT_COMMITTER_DATE=<iso+offset>
git -C <outdir> -c commit.gpgsign=false -c core.hooksPath=/dev/null \
  commit --allow-empty -q -m "contribution <id>"
```

Author and committer dates are both set: GitHub's contribution graph reads the
author date, but leaving the committer date at "now" makes every commit's metadata
visibly inconsistent. The two `-c` flags keep the replay independent of the user's
global git config — `commit.gpgsign=true` would otherwise launch pinentry with no
TTY once per commit, and a global hook would run arbitrary code once per commit.

Branch `main` is created explicitly because GitHub counts commits only on a
repository's default branch.

Commits are invoked via `execFileSync` with an argument array — never a shell
string — so identity values cannot inject shell syntax.

Progress is reported every 100 commits; a multi-thousand-commit replay otherwise
looks hung.

### Script mode

When prompt 8 selects script output, the same commands are written to `replay.sh`
instead of being executed: a `set -e` header, a `test -e` guard that exits non-zero
if the output directory exists, the `git init`, one `git commit` line per entry with
its dates inline, and a closing `echo` reporting the count. The guard matters
because `git init` on an existing repository succeeds silently, so without it a
second `bash replay.sh` would double every commit and exit 0.

The output directory is resolved to an absolute path before rendering, since
`replay.sh` is written to the current directory but may be run from elsewhere.

Values interpolated into `replay.sh` are single-quoted with embedded single quotes
escaped, without exception.

## Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Bad or expired token | GraphQL returns 401, or `errors` names it; throw, exit non-zero |
| Missing scope | Calendar total is low and/or `restrictedContributionsCount` is non-zero; reported, not fatal |
| `errors` array in a 200 response | Throw with the joined messages — never treated as zero contributions |
| Reversed date range | Throw before any request |
| Network error mid-fetch | Propagate; `contributions.json` is not written, so nothing is half-cached |
| Output directory exists | Refuse, exit non-zero, write nothing |
| Zero contributions in range | Report and exit before creating any repo |
| Ctrl-D at any prompt | Abort cleanly with "cancelled, nothing written" |
| `git` not on PATH | Propagate the `execFileSync` error |

## Verification

`test.ts`, run via `node --test test.ts`.

The load-bearing test is the invariant that every synthesised entry lands on its own
calendar day, checked across `+00:00`, `+05:00`, `+05:30`, `-08:00`, `+14:00` and
`-11:00`, including a 300-contribution day. Alongside it, two tests read real git
objects back out of a temporary repository: one asserting a fixture's author dates
and local days exactly, including a commit that crosses the day boundary, and one
asserting that 22 counted contributions produce 22 commits all on the same square.
The generated script is executed with bash and its author dates compared against the
direct replay. Quoting, the script's guard line, the existing-directory refusal, and
the calendar's window-splitting, zero-day filtering and cross-window de-duplication
each have their own test.

## Deliberately skipped

| Skipped | Add when |
|---------|----------|
| CLI flags | Re-running the same prompts becomes tedious |
| Config file | Flags exist and are still tedious |
| Replay resume | A real replay dies mid-run |
| Auto-push, remote creation | Manual push proves annoying rather than reassuring |
| Realistic per-commit times | Someone actually reads the replica's log and cares |

## History

The first implementation of this design walked every accessible repository's default
branch via the REST commits API, and later also collected the commits inside pull
requests to recover squash-merged work. Both passes were removed once the goal was
stated as replicating the contribution graph rather than the commit history: the
graph counts activity the commit log does not contain (PRs opened, reviews, issues,
repositories created), and the commit log contains work the graph never counted
(commits on branches that were squashed away). The GraphQL calendar is both smaller
and correct. The commit-scanning code, its rate-limit retry, its Link-header
pagination and its identity-matching heuristics are all gone.
