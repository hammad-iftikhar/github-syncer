# SDD ledger — plan: docs/superpowers/plans/2026-09-03-github-syncer.md

Spec: docs/superpowers/specs/2026-09-03-github-syncer-design.md (read)
Branch: feat/github-syncer (in-place, not a worktree)

## Preflight scan

Every task appends to the same two files (`github-syncer.ts`, `test.ts`), so every
pair shares a file. Rows below are producer→consumer interface checks plus one
self-consistency row per task.

| Pair | Produced vs consumed | Finding |
|---|---|---|
| T1→T2 | nothing consumed; T2 appends to files T1 creates | clean |
| T1→T3 | nothing consumed directly | clean |
| T1→T4 | `toOffset(utcIso, offset)` → used by `replay`/`renderScript` | signatures match |
| T1→T5 | `isDate`, `isOffset`, `localOffset`, `toOffset` → used by prompts | clean |
| T2→T3 | `paginate<T>(url, token, f?)`, `ghGet(url, token, f?)`, `Fetcher` | signatures match |
| T2→T3 (tests) | `jsonRes()` helper defined in T2's test block, used in T3's | clean; pointer added to T3 Interfaces |
| T3→T4 | `Commit {sha, repo, date}` → T4 FIXTURE shape | matches |
| T3→T5 | `collectCommits(token, since, until, f?)` | clean |
| T4→T5 | `replay`, `renderScript`, `ReplayOpts` | see Ruling R4 |
| T1 self | 9 tests vs impl: ms-drop test relies on `toISOString` always emitting ms | see Ruling R2 |
| T2 self | rate-limit test (reset=+30s) vs `max(1000, reset-now+1000)` ≈ 31s, asserted 25-32s | clean |
| T3 self | URLSearchParams encodes `:` as `%3A`; test asserts encoded form | clean |
| T4 self | `"aaaaaaa1111".slice(0,7)` = `aaaaaaa`; `%aI\|%cI\|%an\|%ae\|%s` indices 0-4 | clean |
| T5 self | entry guard vs "importing does not start main" test; `main` unexported | clean |
| T4→T5 (imports) | both add `node:fs` names in separate statements | see Ruling R3 |
| Test count | 9+8+6+5+1 = 29, matches every task's stated total | clean |

## Rulings

Ruling R1: Implement on in-place branch `feat/github-syncer`, not a git worktree — the repo is two commits of docs with nothing to isolate from, and the plan's deliverable IS this repo. Cost if wrong: the user's working copy is on a branch they must switch off; no data risk.

Ruling R2: `toOffset` returns `shifted.toISOString().slice(0, 19) + offset` instead of the plan's `.replace(/\.\d+Z$/, "").replace(/Z$/, "")` chain — `toISOString()` always emits milliseconds, so the second `replace` is unreachable and a reviewer would correctly flag it as dead code. All Task 1 test expectations are unchanged. Cost if wrong: none; the slice is exact for the fixed-width ISO format `toISOString` guarantees.

Ruling R3: `github-syncer.ts` carries one `import` statement per module. Task 5's `readFileSync`/`statSync`/`writeFileSync` merge into the `node:fs` import Task 4 added rather than opening a second one. Cost if wrong: none, cosmetic.

Ruling R4: `replay()` throwing on an existing output directory is allowed to propagate out of `main()` uncaught. That satisfies the spec's "refuse, exit non-zero, write nothing" — Node exits 1 and prints the message. No try/catch wrapper is required. Cost if wrong: the user sees a stack trace above the message instead of a bare message.

## Progress

Task 1: complete (commits b88a6bd..64b212b, review clean — spec ✅, quality Approved)
Task 1: ⚠️ resolved by controller — `git log -1 --format=%B 64b212b` is the bare subject "Add scaffold and timestamp offset conversion", no trailers. Constraint met.
Task 1: minor (deferred): toOffset does not range-check the parsed offset — "+99:99" passes the regex and shifts nonsensically.
Task 1: minor (deferred): the localOffset test asserts only the output shape, so an inverted sign would pass.
Task 1: Ruling: both Task 1 minors stay deferred rather than entering the fix loop. The offset range check is unreachable from the tool's own flow — `isOffset` gates the only user-supplied offset at the prompt, and no caller constructs one programmatically. Testing localOffset's sign non-circularly requires controlling the process timezone (a second `node --test` process with `TZ=` set), which costs more than the bug it would catch in a function whose whole body is four lines of sign arithmetic. Cost if wrong: a hand-edited commits.json or a future programmatic caller could pass a wild offset and get silently wrong dates; an inverted localOffset sign would show up as a visibly wrong default at the prompt, which the user can correct by typing over it.
Task 2: review — spec ✅, quality Needs fixes. 2 Important (both plan-mandated: the brief's own code), 1 Minor.
Task 2: ⚠️ resolved by controller — `git log -1 --format=%B 28454d1` is the bare subject, no trailers. Constraint met.
Task 2: Ruling: Important #1 (malformed `x-ratelimit-reset` → `Number()` yields NaN → `sleep(NaN)` fires next tick → retry loop spins with no delay) — FIX IT. The finding is correct and the plan's code is wrong: an absent header is safe via `?? 0`, but a non-numeric one is not, and the failure mode is hammering the API in a tight loop, which is exactly what the rate-limit handler exists to prevent. Cheapest correct fix is a finite check falling back to a fixed 60s wait. Cost if wrong: none material; the fallback only engages on a header GitHub never sends.
Task 2: Ruling: Important #2 (`paginate` has no cycle guard if a `next` link repeats the current URL) — DOCUMENT, DO NOT FIX. Link headers are generated by GitHub itself; a self-referential `next` would be a GitHub bug, and adding a visited-set plus a page cap buys defense against a case that cannot arise from the only server this tool talks to. The reviewer's own fallback suggestion — a `// ponytail:` comment naming the ceiling — is the proportionate response. Cost if wrong: against a hypothetical malformed Link header the fetch loops until the user interrupts it; no data is written, since `commits.json` is only written after `collectCommits` returns.
Task 2: Ruling: Minor (extra `accept` / `x-github-api-version` / `user-agent` headers beyond the brief's tests) — keep as-is, no action. They are in the plan's code deliberately: GitHub requires a User-Agent and versioning the Accept header is how the API contract is pinned. Cost if wrong: none.
Task 2: fix round 1/5 (2 addressed, 0 open; commits 28454d1..5911e25)
Task 2: complete (commits 64b212b..5911e25, review clean)
Note: the fix added one test, so running totals shift +1 from the plan's stated counts — 18 now, Task 3 ends at 24, Task 4 at 29, Task 5 at 30. Carry this into each dispatch; a brief's own "expected total" line is stale by one.
Task 3: complete (commits 5911e25..1fdf9c4, review clean — spec ✅, quality Approved)
Task 3: ⚠️ resolved by controller — `git log -1 --format=%B 1fdf9c4` is the bare subject, no trailers.
Task 3: minor (deferred): dedupeSort uses localeCompare while activeRepos uses plain >= for the same ISO shapes — style inconsistency, functionally identical.
Task 3: minor (deferred): the `until=...T23:59:59Z` bound assumes GitHub's until filter includes an exact-second match; a commit authored at exactly 23:59:59Z on the last day could be dropped.
Task 3: Ruling: both minors stay deferred. The localeCompare wart is cosmetic. The until-boundary is a one-second window on one day of a multi-year range, and the cost of losing it is a single contribution square — cheaper to accept than to reason about GitHub's inclusivity semantics. Cost if wrong: at most one commit missing from the replica.
Task 4: review — spec ❌, quality Needs fixes. 2 Important (both plan-mandated — both originate in the plan's own reference code), 3 Minor.
Task 4: Ruling: Important #1 (renderScript's trailing `echo 'created N commits in ${o.dir}'` interpolates o.dir without shq, while every other interpolation in the same function uses it) — FIX IT, and add a test. The finding is correct and the plan's code is wrong: it directly contradicts the binding constraint that every value interpolated into replay.sh is single-quoted with embedded quotes escaped, and a single quote in the output path would emit a malformed script that the user then runs with bash. No existing test catches it because tmpdir paths never contain quotes, so the fix needs a string-level test on renderScript's output rather than another filesystem test. Cost if wrong: none; shq on a quote-free path is a no-op.
Task 4: Ruling: Important #2 (replay leaves a partial history if it dies mid-run, and the refuse-existing-directory rule means the only recovery is deleting the directory and starting from commit 1) — DOCUMENT, DO NOT FIX. Resume was explicitly on the plan's skipped list ("add when a real fetch dies mid-run"), and the recovery the reviewer wants — resumable replay — is a feature, not a bug fix. What is genuinely missing is the `// ponytail:` comment the constraints require for a deliberate simplification. Cost if wrong: a user whose multi-thousand-commit replay dies at commit 4000 deletes the directory and reruns; the commits are empty and cost seconds to regenerate, and commits.json is already cached so no API calls are repeated.
Task 4: Ruling: 3 Minors (duplicated toOffset/message construction between replay and renderScript; the script test compares only %aI; shq called twice per loop iteration) — all deferred, no action. The duplication is two lines and a shared helper would cost more indirection than it saves; the narrower script test still pins the timestamps, which is the property that matters. Cost if wrong: cosmetic.
Task 4: fix round 1/5 (2 addressed, 0 open; commits 04a06fd..df95eee)
Task 4: complete (commits 1fdf9c4..df95eee, review clean)
Note: 30 tests now. Task 5 ends at 31, not the plan's 29.
Task 5: Ruling: the brief's Step 5 smoke test against a real account is replaced with an invalid-token run (`GITHUB_TOKEN=not-a-real-token`), and the implementer is forbidden from seeking credentials (no `gh auth token`, no keychain, no config files). The invalid-token path exercises prompts 1 through the fetch and the 401 error path without sending any real account's data anywhere; handing a subagent live GitHub credentials is not mine to authorise. The live real-token run is deferred to the user. Cost if wrong: the first real fetch is unexercised until the user runs it, so a fault reachable only with a valid token — a pagination or repo-shape surprise on their actual account — would surface then rather than now.
Task 5: review — spec ✅, quality Approved, but 2 Important findings (both plan-mandated) + 2 Minor.
Task 5: ⚠️ resolved by controller — the brief's real-account smoke test stays outstanding by my earlier ruling; deferred to the user, and it will be named explicitly in the handoff.
Task 5: Ruling: Important #1 (Ctrl-D or stdin close during a pending prompt leaves the readline promise permanently unsettled; main()'s try/catch never fires, and Node force-terminates with an internal "unsettled top-level await" warning and exit 13) — FIX IT. The reviewer reproduced it independent of any pipe, by closing a terminal:true interface with a question outstanding, which is what Node's own Ctrl-D handler does on a real TTY. Ctrl-D is the natural cancel gesture in an interactive tool and it currently prints a Node internal warning instead of "aborted, nothing written". The fix is small — readline/promises' question() accepts an AbortSignal, so one AbortController aborted on the interface's close event turns the hang into a catchable rejection. Cost if wrong: a few lines of cancel plumbing in the one function that was meant to stay thin.
Task 5: Ruling: Important #2 (commits.json is written before the summary and before Proceed?, contradicting the design-intent line "the summary block prints before anything is written to disk") — NO CODE CHANGE; the spec's wording is what is wrong. The cache exists precisely so an aborted run does not have to re-hit the API, so writing it before the confirmation is the intended behaviour, and delaying it would defeat the feature. The spec sentence is imprecise about which writes it governs: it means the output directory, not the cache. Fixing the sentence rather than the code. Cost if wrong: none to behaviour; if a future reader wants the stricter guarantee they would be changing the feature, not restoring it.
Task 5: minor (deferred): commits.json is JSON.parse'd and trusted as Commit[] with no shape validation — a truncated or hand-edited cache surfaces as a raw SyntaxError stack trace rather than "cache is invalid, delete it".
Task 5: minor (deferred): askYes treats any answer not starting with "y" as no, with no re-ask, so a typo silently takes the no branch.
Task 5: Ruling: both Task 5 minors deferred. The cache is tool-generated in every normal case, and askYes's no-default is the safe direction to fall in for every question it is asked. Cost if wrong: a hand-edited cache gives an ugly error instead of a friendly one; a mistyped answer to "Commit now?" writes replay.sh instead of committing, which is the reviewable path and is corrected by rerunning.
Task 5: fix round 1/5 (2 addressed, 0 open; commits 877f4fa..6fd2d0a)
Task 5: complete (commits df95eee..6fd2d0a, review clean)
All 5 tasks complete. Proceeding to final whole-branch review.

## Final whole-branch review (b88a6bd..6fd2d0a, opus)

Verdict: With fixes. 1 Critical, 4 Important, ~12 Minor. Deferred-minor triage: all 9 accepted, with two framing corrections (the localOffset ruling overestimated the cost of a non-circular test; the until-boundary ruling understated the range imprecision).

Ruling F1: Critical #1 (script mode has no existing-directory guard — `main()` writes replay.sh without the `existsSync` check that lives inside `replay()`, and the generated script has none either, so `git init` on an existing repo is a successful no-op and a second `bash replay.sh` silently doubles every commit, exit 0) — FIX. The reviewer reproduced it: 2 commits became 4, every date twice. It contradicts the spec's own Replay section, whose refuse-if-exists rule the Script mode subsection inherits, and a doubled contribution graph is the exact silent-wrongness this design exists to prevent. Plan defect, not implementer drift. Cost if wrong: none; the guard only fires on a path the spec already forbids.
Ruling F2: Important #2 (no token-scope check, so a fine-grained or public-only token yields a truthful-looking replica with every private commit missing and no warning) — FIX. The private-repo commits are the tool's entire purpose, so an invisible partial result is worse than a crash. Five lines reading `x-oauth-scopes` turns it visible. Cost if wrong: a spurious warning for a token shape that reports scopes unexpectedly.
Ruling F3: Important #3 (GitHub's since/until filter keys off committer date while the tool stores and replays author date, so on rebased or imported history the requested window and the replayed dates diverge) — DOCUMENT ONLY. Changing the query would mean client-side filtering of a much larger fetch, which trades a rare inaccuracy for a permanent cost. Two lines of documentation, in README and spec. This subsumes the earlier T23:59:59Z minor, whose framing the reviewer correctly called too narrow. Cost if wrong: a user with rewritten history gets a replica whose range is off and only the docs warned them.
Ruling F4: Important #4 (the cache-reuse prompt shows only count and mtime, so a commits.json from a different token or range is offered indistinguishably) — FIX, one line: print the date range derived from the cached commits. Cost if wrong: none.
Ruling F5: Important #5 (paginate returns partial results when a 404/409 arrives mid-pagination, since the empty-repo interpretation is only true on the first request) — FIX, five characters: only treat it as empty when nothing has been collected yet. Cost if wrong: none.
Ruling F6: Minors taken into the same wave because each is a one-liner guarding against a silently wrong or badly-located replica: `-c commit.gpgsign=false` and `-c core.hooksPath=/dev/null` on every replay commit (a user with global gpgsign would otherwise stall on pinentry thousands of times), `--` before the directory argument, resolving the output directory to an absolute path before rendering replay.sh (so running the script from elsewhere cannot build the replica in the wrong place), the README's false "Enter works" claim plus its silence on script mode, the cache prompt, and the fact that commits.json holds private repository names, and renaming the overpromising test. Cost if wrong: a slightly larger fix diff than strictly required to clear the Critical.
Ruling F7: the reviewer's best-missing-test recommendation — a day-boundary case in the git-level replay test — is taken. Every existing fixture converts within one calendar day at +05:00, so the single property the product delivers, which square a commit lands on, is never verified through real git objects. Cost if wrong: none.
Ruling F8: parked, not fixed — the bash-executed quoted-path test (the string-level test already pins shq usage and the reviewer executed the behavioural version by hand), @types/node as a devDependency to make tsconfig type-check for real, the token prompt being skipped rather than defaulted when GITHUB_TOKEN is set, isDate accepting 2024-02-31, no since<=until check, Ctrl-D exiting 0, and piped stdin aborting after the first answer. Every one of these fails visibly or costs a dependency to fix. Cost if wrong: a user hits an ugly error instead of a friendly one, or tsconfig remains decorative.
