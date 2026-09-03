# github-syncer — design

**Date:** 2026-09-03
**Status:** approved

## Purpose

Read the commit history of a GitHub account via the API, then rebuild that
history as backdated empty commits in a fresh local git repo attributed to a
different account. Pushing the replica makes the source account's activity —
including commits in private repos — visible on the destination account's
contribution graph.

Intended use is a single person consolidating their own activity: a work
account as source, a personal profile as destination. It is not a tool for
claiming work you did not do.

## Non-goals

- Copying code, diffs, branches, or commit messages. Commits are empty.
- Pushing. The tool prints the `git remote add` / `git push` commands and stops.
- Creating the destination repo via API.
- Any non-interactive interface: no CLI flags, no config file.
- Resuming a partially-completed fetch.

## Runtime

Single file `github-syncer.ts`, run as `node github-syncer.ts`. Node 24 strips
TypeScript types natively, so there is no build step and no `tsconfig.json` is
required to run. Zero dependencies: global `fetch`, `node:readline/promises`,
`node:child_process`, `node:fs`.

A `tsconfig.json` may be added purely for editor type-checking; it is not part
of the run path.

## Interaction

Nine prompts, asked in order. Every prompt accepts its default on
a bare Enter.

| # | Prompt | Default |
|---|--------|---------|
| 1 | Source GitHub token | `$GITHUB_TOKEN` if set; otherwise prompt with terminal echo muted |
| 2 | Since date (`YYYY-MM-DD`) | one year before today |
| 3 | Until date (`YYYY-MM-DD`) | today |
| 4 | Replay timezone offset | the machine's current UTC offset, e.g. `+05:00` |
| 5 | Destination author name | `git config user.name` |
| 6 | Destination author email | `git config user.email` |
| 7 | Output directory | `./replica` |
| 8 | Commit now, or only write `replay.sh`? | commit now |
| 9 | Summary, then proceed? | **no** |

Prompt 6 prints a warning that the email must be a *verified* email on the
destination account, or GitHub attributes the commits to no one and the
contribution graph stays empty.

Prompt 9 prints the commit count, the earliest and latest commit dates, the
destination identity, and the output path before anything is written to disk.
It is the only prompt that defaults to no.

Dates from prompts 2 and 3 are validated as `YYYY-MM-DD` and re-asked on bad
input. Prompt 4 is validated as `±HH:MM`. Prompts 5 and 6 reject empty values,
since an empty author identity produces commits git will not attribute.

## Fetch

1. `GET /user` → `login`. A non-200 here means a bad token; report and exit.
2. Paginate `GET /user/repos?affiliation=owner,collaborator,organization_member&per_page=100`,
   following the `Link: rel="next"` header, collecting `full_name` and `pushed_at`.
3. Drop any repo whose `pushed_at` is earlier than the since date. This prunes
   most of the list for free and is the main cost saving.
4. For each surviving repo, paginate
   `GET /repos/{full_name}/commits?author={login}&since={since}&until={until}&per_page=100`.
   The `author` parameter matches by login or email, so it returns only the
   user's own commits. Treat `409` (empty repository) and `404` (access lost
   between listing and reading) as "no commits" and continue.
5. Dedupe by SHA — the same commit is reachable through forks and mirrors.
6. Sort ascending by date and write `commits.json`.

No fork filtering. `?author={login}` already restricts results to the user's
own commits, so upstream history in a fork is excluded and the user's own
commits in a fork are kept.

### Rate limiting

When a response reports the limit exhausted — status `403` or `429` with
`X-RateLimit-Remaining: 0` — sleep until the epoch second in
`X-RateLimit-Reset` (plus one second) and retry the same request. Reacting to
the rejection rather than pre-emptively sleeping on `remaining: 0` avoids
stalling for an hour after the final request of a run. No exponential backoff,
no retry library.

### commits.json

```json
[{ "sha": "a1b2c3d…", "repo": "org/name", "date": "2024-03-11T09:22:07Z" }]
```

Dates are exactly as GitHub returns them: ISO 8601 normalized to UTC.

If `commits.json` already exists, the tool reports its commit count and
modification time and asks whether to reuse it instead of calling the API.

## Timezone handling

Both `GET /repos/{o}/{r}/commits` and `GET /repos/{o}/{r}/git/commits/{sha}`
return author dates normalized to UTC (`…Z`). The commit's original UTC offset
is not exposed by the REST API and cannot be recovered from it.

This matters because GitHub places a commit on the contribution graph using the
author date's local day. Replaying a `22:00 UTC` timestamp as UTC puts it on a
different calendar square than the `+05:00` day it was actually authored on.

The tool therefore converts each UTC timestamp to the offset from prompt 4 and
writes that offset into the replayed commit. With the offset set to the zone the
work was actually done in, calendar days match. Commits authored in a different
zone than the chosen offset may land one day off. This is a known and accepted
limit, not a bug to fix later — the API does not carry the information needed to
do better.

## Replay

Refuse to proceed if the output directory already exists, rather than appending
a second copy of the history. Report the path and exit.

```
git init -q -b main <outdir>
```

Then, per commit, in date order:

```
GIT_AUTHOR_NAME=<name>  GIT_AUTHOR_EMAIL=<email>  GIT_AUTHOR_DATE=<iso+offset>
GIT_COMMITTER_NAME=<name> GIT_COMMITTER_EMAIL=<email> GIT_COMMITTER_DATE=<iso+offset>
git commit --allow-empty -q -m "sync <sha[0:7]>"
```

Author and committer dates are both set: GitHub's contribution graph reads the
author date, but leaving the committer date at "now" makes every commit's
metadata visibly inconsistent.

Branch `main` is created explicitly because GitHub counts commits only on a
repository's default branch.

Commits are invoked via `execFileSync` with an argument array — never a shell
string — so commit messages and identity values cannot inject shell syntax.

Progress is reported as a counter every 100 commits; a multi-thousand-commit
replay otherwise looks hung.

### Script mode

When prompt 8 selects script output, the same commands are written to
`replay.sh` instead of being executed: a `set -e` header, the `git init`, one
`git commit` line per commit with its dates inline, and a closing `echo`
reporting the commit count. The script is not made executable and is not run;
the tool prints `bash replay.sh` as the next step, and the `git push`
instructions are left to that later run rather than baked into the script.

Values interpolated into `replay.sh` are single-quoted with embedded single
quotes escaped.

## Completion

Print the number of commits created, the output path, and:

```
cd <outdir>
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

## Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Bad or expired token (`GET /user` ≠ 200) | Report status, exit non-zero |
| Repo returns 409 / 404 | Skip repo, continue |
| Rate limit exhausted | Sleep to reset, retry same request |
| Network error mid-fetch | Propagate; `commits.json` is not written, so nothing is half-cached |
| Output directory exists | Refuse, exit non-zero, write nothing |
| Zero commits in range | Report and exit before creating any repo |
| `git` not on PATH | Propagate the `execFileSync` error |

## Verification

`test.ts`, run via `node --test test.ts`.

One test covers the only logic that can fail silently: a fixture of three
commits with known UTC timestamps is generated into a temporary directory, and
`git log --format=%aI` in the resulting repo must equal the expected
offset-converted timestamps exactly, in order, including offsets. A drift in
timezone conversion or date formatting fails this test.

A second, cheaper assertion checks that the replay refuses an existing output
directory.

## Deliberately skipped

| Skipped | Add when |
|---------|----------|
| CLI flags | Re-running the same prompts becomes tedious |
| Config file | Flags exist and are still tedious |
| Fetch resume | A real fetch dies mid-run |
| Auto-push, remote creation | Manual push proves annoying rather than reassuring |
| Per-repo or per-org filtering | An unwanted repo's commits actually pollute the result |
| Non-empty commits, real diffs | Empty commits turn out not to register |
