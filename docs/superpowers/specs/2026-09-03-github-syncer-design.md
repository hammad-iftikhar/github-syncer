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

Ten prompts at most, asked in order. Every prompt accepts its default on a bare Enter.

| # | Prompt | Default | Asked when |
|---|--------|---------|-----------|
| 1 | Reuse `contributions.json`? | yes | the cache exists and is valid |
| 2 | Source GitHub token | `$GITHUB_TOKEN` if set; otherwise prompt with echo muted | the cache is not being reused |
| 3 | Since date (`YYYY-MM-DD`) | one year before today | as above |
| 4 | Until date (`YYYY-MM-DD`) | today | as above |
| 5 | Timezone offset to stamp commits with | the machine's current UTC offset | always |
| 6 | Destination author name | `git config user.name` | always |
| 7 | Destination author email | `git config user.email` | always |
| 8 | Output directory | `./replica` | always |
| 9 | Commit now, or only write `replay.sh`? | commit now | always |
| 10 | Summary, then proceed? | **no** | always |

The cache question comes before the token question because reusing the cache needs no
token at all, and asking for a secret that will not be used is worse than asking one
question out of order. The prompt names the login the cache was fetched for: a cache
from another account is otherwise indistinguishable, and accepting it would replicate
the wrong person's graph.

Prompt 7 prints a warning that the email must be a *verified* email on the destination
account, or GitHub attributes the commits to no one and the contribution graph stays
empty.

Prompt 10 prints the contribution total, the number of active days, the date range, the
busiest day, the destination identity, and the output path before anything is written to
the output directory or to `replay.sh`. It is the only prompt that defaults to no.
`contributions.json` is the exception: it is deliberately written earlier, as a cache, so
an aborted run does not have to re-fetch.

Dates are validated as `YYYY-MM-DD` and round-tripped through `Date`, so `2024-02-30`
is rejected rather than silently rolled over into March — the plain string comparisons
used on dates elsewhere would otherwise disagree with the parsed value. The offset is
validated against real zones only, `±(00-14):(00|15|30|45)`: git accepts `+99:99` and
records a commit whose absolute instant is days away from what its local date implies.
Name, email, and directory reject empty values.

The existing-directory check runs immediately after prompt 8, before the summary, so a
run that will be refused is refused before the user confirms it.

## Fetching the calendar

`GITHUB_TOKEN` or the prompt supplies the token. The token needs `read:user`, and `repo`
for private-repository contributions to be counted.

The window arithmetic is the subtle part, and getting it wrong undercounts the graph
silently. Two facts drive it:

- `contributionsCollection` accepts at most one year per query.
- Its `from`/`to` arguments filter by **instant** — "only contributions made at this time
  or later" — while the calendar buckets each contribution by its own *local* date, and
  an offset can sit up to 14 hours from UTC.

Together those mean a calendar date's contributions span roughly two UTC days, so a date
lying on a window seam is returned with only *part* of its count. An earlier revision of
this design asserted the opposite — that a day's count is a property of the day and not
of the window — and took `Math.max` over non-overlapping windows, which threw away the
smaller half of one date's activity per seam.

The fix is not to sum the partials, which would be correct only under that one reading of
the API. Instead:

1. Windows are 364 days long but advance only 362, overlapping by two days, and the
   requested range is padded by one day at each end. Every date in `[since, until]` is
   then wholly interior to at least one window — 24 hours of padding covers the 14-hour
   maximum offset with room to spare.
2. Each window is one POST to `https://api.github.com/graphql` requesting
   `viewer { login, contributionsCollection { restrictedContributionsCount,
   contributionCalendar { totalContributions, weeks { contributionDays { date,
   contributionCount } } } } }`.
3. Each date's count is taken with `Math.max` across windows. Since some window holds the
   date whole, the true full count wins; and a max cannot double-count a date however the
   API treats its edges. This is correct under both readings of the argument semantics,
   which is why it is preferred to summing.
4. Days with a zero count are dropped, as are dates outside the requested range — the
   calendar is week-aligned and the windows are padded, so both ends overhang.
5. Days are returned sorted ascending by date, alongside the viewer's login.

### Integrity check

Each window reports its own `totalContributions`. Only a *shortfall* is a fault: the
`weeks` array is week-aligned and the windows are padded, so it ordinarily contains days
outside the window and sums to more than the reported total — those dates are discarded by
the range filter. Summing to *less* than the total means days were lost in parsing, and is
reported as a warning naming both numbers. This is the check that turns the whole class of
"quietly short replica" bug into something the user sees on the first run. Requesting
`totalContributions` costs nothing extra, since it rides in the same query.

`restrictedContributionsCount` is a per-window total over near-disjoint sets rather than a
per-date property, so it is summed across windows and reported as an approximation — the
two-day overlaps make it a slight over-estimate. Taking a maximum instead, as an earlier
revision did, understated it by a factor of the window count. The message states the
consequence — that contributions were made in private repositories this token cannot see,
and that a total lower than the profile graph means the token needs `repo` scope — rather
than implying anything about whether those contributions are inside the daily counts.

### Error handling

GraphQL reports failures inside a 200 response body, so an unchecked `errors` array would
read as "no contributions" — the silent wrongness this tool can least afford. Both a
non-ok status and a non-empty `errors` array throw with the message.

Rate limiting needs no special handling: each query costs one point of a 5,000-per-hour
budget and a decade of history is eleven queries, issued serially. A 403 or 429 fails the
status check and throws; a GraphQL `RATE_LIMITED` error arrives inside a 200 and hits the
`errors` check. Neither can be mistaken for an empty graph.

### contributions.json

```json
{
  "login": "octocat",
  "since": "2025-09-03",
  "until": "2026-09-03",
  "fetchedAt": "2026-09-03T12:00:00.000Z",
  "days": [{ "date": "2026-09-01", "count": 22 }]
}
```

The provenance fields exist so a stale cache cannot be reused blindly: the login is shown
in the reuse prompt, and the requested range is recorded because the first and last
*active* dates are not the same thing as the range that was asked for. The file is
validated on read — every field's type, both date formats, and positive integer counts,
`fetchedAt` included, since the reuse banner formats it — and a malformed cache is
reported and ignored rather than parsed into a wrong replica or crashing on a missing
field.

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

Commits are invoked via `execFileSync` with an argument array — never a shell string — so
identity values cannot inject shell syntax. `GIT_DIR`, `GIT_WORK_TREE` and
`GIT_INDEX_FILE` are cleared from the child environment: inherited from the caller they
override `-C` and would land the replica's commits in another repository.

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
| Malformed `contributions.json` | Report and ignore the cache; fetch instead |
| Window total disagrees with its days | Warn naming both numbers; continue |

## Verification

`test.ts`, run via `node --test test.ts`.

Two properties carry the design, and each has a test that fails if it breaks.

The first is that every synthesised entry lands on the calendar day it was counted on,
checked across `+00:00`, `+05:00`, `+05:30`, `-08:00`, `+14:00` and `-11:00`, including a
300-contribution day. Alongside it, two tests read real git objects back out of a
temporary repository: one asserting a fixture's author dates, committer dates and local
days exactly, including a commit that crosses the day boundary, and one asserting that 22
counted contributions produce 22 commits all on the same square.

The second is that every date in the requested range is wholly interior to some window —
the property that makes `Math.max` correct. It is tested directly, over four ranges from
one day to a decade, by checking that each date's UTC day plus fourteen hours on either
side fits inside a single window. A companion test feeds the calendar a stub that answers according to the window it is
actually handed — a full count only when the seam date's whole instant span is inside the
window, a partial otherwise — and asserts the full count survives. Against
non-overlapping windows no window holds that date whole, so the partial is all it can see
and the test fails; that was verified directly against the previous geometry rather than
assumed.

The generated script is executed with bash and its author dates compared against the
direct replay, so the two paths cannot silently diverge. Quoting, the script's guard line,
the existing-directory refusal, the GraphQL error-inside-200 check, the per-window
integrity warning, and the calendar's zero-day and out-of-range filtering each have their
own test.

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
