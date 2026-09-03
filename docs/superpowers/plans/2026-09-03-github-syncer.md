# github-syncer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One interactive TypeScript command that reads a GitHub account's commit history via the API and rebuilds it as backdated empty commits in a fresh local git repo under a different author identity.

**Architecture:** A single module, `github-syncer.ts`, exporting small pure functions (timestamp conversion, pagination, dedupe, script rendering) plus an interactive `main()` that is only invoked when the file is run directly. `test.ts` imports those pure functions, so the interactive shell stays untested and everything that can silently produce wrong data is covered. Network access is injected as a `Fetcher` parameter defaulting to global `fetch`, which is what makes the fetch layer testable without a token.

**Tech Stack:** Node 24 (native TypeScript type-stripping, no build step), global `fetch`, `node:readline/promises`, `node:child_process`, `node:test`. Zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-github-syncer-design.md`

## Global Constraints

- Zero runtime dependencies. `node_modules/` must never be needed to run the tool. Only `node:*` built-ins and global `fetch`.
- Single implementation file `github-syncer.ts` at the repo root; single test file `test.ts` at the repo root. Do not create a `src/` tree.
- `package.json` contains `{"type": "module"}` and no `dependencies` key.
- Imports between local files must carry the real `.ts` extension (`./github-syncer.ts`) — Node's type-stripping requires it.
- Run tests with `node --test test.ts`. No test framework, no fixtures directory, no mocking library.
- Commits are always empty (`git commit --allow-empty`) with the message `sync <sha[0:7]>`. Never copy source commit messages or diffs.
- Every `git` invocation goes through `execFileSync` with an argument array. Never build a shell command string.
- Branch name is always `main`, created explicitly via `git init -b main`.
- Author date and committer date are always set to the same value.
- GitHub REST returns author dates as UTC `Z`; the original offset is unrecoverable. All conversion to a local offset uses the user-supplied offset, never a guess per commit.
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling.

---

### Task 1: Scaffold and timestamp conversion

The offset conversion is the only piece of arithmetic in the project and the one place a silent error moves every commit to the wrong calendar square. It gets built first, with tests.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `github-syncer.ts`
- Test: `test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toOffset(utcIso: string, offset: string): string`, `localOffset(d?: Date): string`, `isDate(s: string): boolean`, `isOffset(s: string): boolean`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "github-syncer",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node github-syncer.ts",
    "test": "node --test test.ts"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

This exists only so editors type-check the file. It is never invoked to build anything.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "lib": ["es2023", "dom"]
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 3: Write the failing tests**

Create `test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toOffset, localOffset, isDate, isOffset } from "./github-syncer.ts";

test("toOffset re-expresses a UTC instant in a positive offset", () => {
  assert.equal(toOffset("2024-03-11T09:22:07Z", "+05:00"), "2024-03-11T14:22:07+05:00");
});

test("toOffset re-expresses a UTC instant in a negative offset, crossing the date line", () => {
  assert.equal(toOffset("2024-03-11T02:00:00Z", "-05:00"), "2024-03-10T21:00:00-05:00");
});

test("toOffset handles a half-hour offset", () => {
  assert.equal(toOffset("2024-03-11T09:00:00Z", "+05:30"), "2024-03-11T14:30:00+05:30");
});

test("toOffset drops milliseconds", () => {
  assert.equal(toOffset("2024-03-11T09:22:07.123Z", "+00:00"), "2024-03-11T09:22:07+00:00");
});

test("toOffset rejects a malformed offset", () => {
  assert.throws(() => toOffset("2024-03-11T09:22:07Z", "5"), /offset/);
});

test("toOffset rejects a malformed date", () => {
  assert.throws(() => toOffset("not-a-date", "+00:00"), /date/);
});

test("localOffset formats a whole-hour zone", () => {
  // getTimezoneOffset returns minutes to ADD to local to reach UTC, so +05:00 is -300.
  assert.equal(localOffset(new Date("2024-03-11T00:00:00Z")).match(/^[+-]\d{2}:\d{2}$/) !== null, true);
});

test("isDate accepts YYYY-MM-DD and rejects anything else", () => {
  assert.equal(isDate("2024-03-11"), true);
  assert.equal(isDate("2024-3-1"), false);
  assert.equal(isDate("11-03-2024"), false);
  assert.equal(isDate(""), false);
});

test("isOffset accepts signed HH:MM only", () => {
  assert.equal(isOffset("+05:00"), true);
  assert.equal(isOffset("-05:30"), true);
  assert.equal(isOffset("05:00"), false);
  assert.equal(isOffset("+5:00"), false);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test test.ts`
Expected: FAIL — `Cannot find module './github-syncer.ts'`.

- [ ] **Step 5: Write the minimal implementation**

Create `github-syncer.ts`:

```ts
export function toOffset(utcIso: string, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset: ${offset}`);
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${utcIso}`);
  const sign = m[1] === "-" ? -1 : 1;
  const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date(ms + minutes * 60_000);
  return shifted.toISOString().replace(/\.\d+Z$/, "").replace(/Z$/, "") + offset;
}

export function localOffset(d: Date = new Date()): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export const isDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const isOffset = (s: string): boolean => /^[+-]\d{2}:\d{2}$/.test(s);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json github-syncer.ts test.ts
git commit -m "Add scaffold and timestamp offset conversion"
```

---

### Task 2: GitHub HTTP layer

Pagination and rate-limit retry, both driven by response headers. A `Fetcher` parameter is threaded through so tests never touch the network.

**Files:**
- Modify: `github-syncer.ts` (append)
- Test: `test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type Fetcher = (url: string, init?: RequestInit) => Promise<Response>`
  - `nextLink(header: string | null): string | null`
  - `ghGet(url: string, token: string, f?: Fetcher, sleep?: (ms: number) => Promise<void>): Promise<Response>`
  - `paginate<T>(url: string, token: string, f?: Fetcher): Promise<T[]>`

- [ ] **Step 1: Write the failing tests**

Append to `test.ts`:

```ts
import { nextLink, ghGet, paginate, type Fetcher } from "./github-syncer.ts";

function jsonRes(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("nextLink extracts the rel=next URL", () => {
  const h = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
  assert.equal(nextLink(h), "https://api.github.com/x?page=2");
});

test("nextLink returns null when there is no next page", () => {
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test("ghGet sends the bearer token", async () => {
  let seen: string | undefined;
  const f: Fetcher = async (_url, init) => {
    seen = new Headers(init?.headers).get("authorization") ?? undefined;
    return jsonRes([]);
  };
  await ghGet("https://api.github.com/user", "tok123", f);
  assert.equal(seen, "Bearer tok123");
});

test("ghGet sleeps and retries once when the rate limit is exhausted", async () => {
  const calls: string[] = [];
  let slept = 0;
  const reset = Math.floor(Date.now() / 1000) + 30;
  const f: Fetcher = async () => {
    calls.push("call");
    return calls.length === 1
      ? jsonRes({ message: "rate limited" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, 403)
      : jsonRes([{ ok: true }]);
  };
  const res = await ghGet("https://api.github.com/user", "t", f, async (ms) => { slept = ms; });
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  assert.ok(slept > 25_000 && slept <= 32_000, `slept ${slept}`);
});

test("ghGet does not retry a 403 that is not a rate limit", async () => {
  let n = 0;
  const f: Fetcher = async () => { n++; return jsonRes({ message: "forbidden" }, {}, 403); };
  const res = await ghGet("https://api.github.com/user", "t", f, async () => {});
  assert.equal(n, 1);
  assert.equal(res.status, 403);
});

test("paginate follows Link headers and concatenates pages", async () => {
  const f: Fetcher = async (url) =>
    url.includes("page=2")
      ? jsonRes([{ id: 3 }])
      : jsonRes([{ id: 1 }, { id: 2 }], { link: '<https://api.github.com/r?page=2>; rel="next"' });
  const all = await paginate<{ id: number }>("https://api.github.com/r", "t", f);
  assert.deepEqual(all.map((x) => x.id), [1, 2, 3]);
});

test("paginate treats 409 and 404 as an empty repository", async () => {
  const empty: Fetcher = async () => jsonRes({ message: "Git Repository is empty." }, {}, 409);
  assert.deepEqual(await paginate("https://api.github.com/r/commits", "t", empty), []);
  const gone: Fetcher = async () => jsonRes({ message: "Not Found" }, {}, 404);
  assert.deepEqual(await paginate("https://api.github.com/r/commits", "t", gone), []);
});

test("paginate throws on other errors", async () => {
  const boom: Fetcher = async () => jsonRes({ message: "server error" }, {}, 500);
  await assert.rejects(() => paginate("https://api.github.com/r", "t", boom), /500/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test.ts`
Expected: FAIL — `nextLink`, `ghGet`, `paginate` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `github-syncer.ts`:

```ts
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(header);
  return m ? m[1] : null;
}

export async function ghGet(
  url: string,
  token: string,
  f: Fetcher = fetch,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<Response> {
  for (;;) {
    const res = await f(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "github-syncer",
      },
    });
    const exhausted =
      (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
    if (!exhausted) return res;
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const wait = Math.max(1_000, reset - Date.now() + 1_000);
    console.error(`rate limit hit, sleeping ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

export async function paginate<T>(url: string, token: string, f: Fetcher = fetch): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  while (next) {
    const res = await ghGet(next, token, f);
    // 409 = empty repo, 404 = access lost between listing and reading. Neither is fatal.
    if (res.status === 409 || res.status === 404) return out;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${next}`);
    out.push(...((await res.json()) as T[]));
    next = nextLink(res.headers.get("link"));
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add github-syncer.ts test.ts
git commit -m "Add GitHub HTTP layer with pagination and rate-limit retry"
```

---

### Task 3: Commit collection

Repo listing, the `pushed_at` prune that makes the fetch cheap, and dedupe/sort.

**Files:**
- Modify: `github-syncer.ts` (append)
- Test: `test.ts` (append)

**Interfaces:**
- Consumes: `paginate`, `ghGet`, `Fetcher` from Task 2, and the `jsonRes(body, headers?, status?)` test helper already defined in `test.ts` by Task 2.
- Produces:
  - `interface Repo { full_name: string; pushed_at: string | null }`
  - `interface ApiCommit { sha: string; commit: { author: { date: string } | null } }`
  - `interface Commit { sha: string; repo: string; date: string }`
  - `activeRepos(repos: Repo[], since: string): Repo[]`
  - `dedupeSort(commits: Commit[]): Commit[]`
  - `whoAmI(token: string, f?: Fetcher): Promise<string>`
  - `collectCommits(token: string, since: string, until: string, f?: Fetcher): Promise<Commit[]>`

- [ ] **Step 1: Write the failing tests**

Append to `test.ts`:

```ts
import { activeRepos, dedupeSort, whoAmI, collectCommits, type Repo, type Commit } from "./github-syncer.ts";

test("activeRepos drops repos untouched since the start date", () => {
  const repos: Repo[] = [
    { full_name: "me/old", pushed_at: "2019-01-01T00:00:00Z" },
    { full_name: "me/new", pushed_at: "2025-06-01T00:00:00Z" },
    { full_name: "me/never", pushed_at: null },
  ];
  assert.deepEqual(activeRepos(repos, "2024-01-01").map((r) => r.full_name), ["me/new", "me/never"]);
});

test("dedupeSort removes duplicate shas and orders by date", () => {
  const input: Commit[] = [
    { sha: "bbb", repo: "me/b", date: "2024-05-01T00:00:00Z" },
    { sha: "aaa", repo: "me/a", date: "2024-01-01T00:00:00Z" },
    { sha: "bbb", repo: "me/b-fork", date: "2024-05-01T00:00:00Z" },
  ];
  const out = dedupeSort(input);
  assert.deepEqual(out.map((c) => c.sha), ["aaa", "bbb"]);
  assert.equal(out[1].repo, "me/b", "first occurrence of a sha wins");
});

test("whoAmI returns the token owner's login", async () => {
  const f: Fetcher = async () => jsonRes({ login: "octocat" });
  assert.equal(await whoAmI("t", f), "octocat");
});

test("whoAmI throws a clear error on a bad token", async () => {
  const f: Fetcher = async () => jsonRes({ message: "Bad credentials" }, {}, 401);
  await assert.rejects(() => whoAmI("bad", f), /401/);
});

test("collectCommits queries only active repos and returns sorted unique commits", async () => {
  const asked: string[] = [];
  const f: Fetcher = async (url) => {
    if (url.includes("/user/repos")) {
      return jsonRes([
        { full_name: "me/old", pushed_at: "2019-01-01T00:00:00Z" },
        { full_name: "me/live", pushed_at: "2025-06-01T00:00:00Z" },
      ]);
    }
    if (url.endsWith("/user")) return jsonRes({ login: "me" });
    asked.push(url);
    return jsonRes([
      { sha: "c2", commit: { author: { date: "2024-05-02T10:00:00Z" } } },
      { sha: "c1", commit: { author: { date: "2024-05-01T10:00:00Z" } } },
    ]);
  };
  const commits = await collectCommits("t", "2024-01-01", "2024-12-31", f);
  assert.equal(asked.length, 1, "the stale repo is never queried");
  assert.match(asked[0], /me\/live\/commits/);
  assert.match(asked[0], /author=me/);
  assert.match(asked[0], /since=2024-01-01T00%3A00%3A00Z/);
  assert.match(asked[0], /until=2024-12-31T23%3A59%3A59Z/);
  assert.deepEqual(commits.map((c) => c.sha), ["c1", "c2"]);
  assert.equal(commits[0].repo, "me/live");
});

test("collectCommits skips commits with no author date", async () => {
  const f: Fetcher = async (url) => {
    if (url.endsWith("/user")) return jsonRes({ login: "me" });
    if (url.includes("/user/repos")) return jsonRes([{ full_name: "me/r", pushed_at: "2025-01-01T00:00:00Z" }]);
    return jsonRes([{ sha: "x", commit: { author: null } }]);
  };
  assert.deepEqual(await collectCommits("t", "2024-01-01", "2024-12-31", f), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test.ts`
Expected: FAIL — `activeRepos` and friends are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `github-syncer.ts`:

```ts
export interface Repo {
  full_name: string;
  pushed_at: string | null;
}

export interface ApiCommit {
  sha: string;
  commit: { author: { date: string } | null };
}

export interface Commit {
  sha: string;
  repo: string;
  date: string;
}

const API = "https://api.github.com";

// pushed_at and `since` are both ISO-prefixed, so a string compare is a date compare.
export function activeRepos(repos: Repo[], since: string): Repo[] {
  return repos.filter((r) => !r.pushed_at || r.pushed_at >= since);
}

export function dedupeSort(commits: Commit[]): Commit[] {
  const seen = new Map<string, Commit>();
  for (const c of commits) if (!seen.has(c.sha)) seen.set(c.sha, c);
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function whoAmI(token: string, f: Fetcher = fetch): Promise<string> {
  const res = await ghGet(`${API}/user`, token, f);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — token rejected by GET /user`);
  return ((await res.json()) as { login: string }).login;
}

export async function collectCommits(
  token: string,
  since: string,
  until: string,
  f: Fetcher = fetch,
): Promise<Commit[]> {
  const login = await whoAmI(token, f);
  const repos = await paginate<Repo>(
    `${API}/user/repos?affiliation=owner,collaborator,organization_member&per_page=100`,
    token,
    f,
  );
  const live = activeRepos(repos, since);
  console.log(`${repos.length} repos accessible, ${live.length} touched since ${since}`);

  // ponytail: repos are walked serially. Fine at a few hundred repos; parallelise
  // with a small concurrency pool if a fetch ever takes long enough to care about.
  const out: Commit[] = [];
  for (const [i, repo] of live.entries()) {
    const q = new URLSearchParams({
      author: login,
      since: `${since}T00:00:00Z`,
      until: `${until}T23:59:59Z`,
      per_page: "100",
    });
    const commits = await paginate<ApiCommit>(`${API}/repos/${repo.full_name}/commits?${q}`, token, f);
    for (const c of commits) {
      if (!c.commit.author?.date) continue;
      out.push({ sha: c.sha, repo: repo.full_name, date: c.commit.author.date });
    }
    console.log(`  [${i + 1}/${live.length}] ${repo.full_name}: ${commits.length}`);
  }
  return dedupeSort(out);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add github-syncer.ts test.ts
git commit -m "Add commit collection with pushed_at pruning and sha dedupe"
```

---

### Task 4: Replay and script rendering

The end-to-end check lives here: build a real repo in a temp directory and read the timestamps back out of git.

**Files:**
- Modify: `github-syncer.ts` (append)
- Test: `test.ts` (append)

**Interfaces:**
- Consumes: `toOffset` (Task 1), `Commit` (Task 3).
- Produces:
  - `interface ReplayOpts { dir: string; name: string; email: string; offset: string }`
  - `shq(s: string): string`
  - `commitEnv(name: string, email: string, date: string): Record<string, string>`
  - `replay(commits: Commit[], o: ReplayOpts): void`
  - `renderScript(commits: Commit[], o: ReplayOpts): string`

- [ ] **Step 1: Write the failing tests**

Append to `test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay, renderScript, shq, commitEnv, type ReplayOpts } from "./github-syncer.ts";

const FIXTURE: Commit[] = [
  { sha: "aaaaaaa1111", repo: "me/one", date: "2024-03-11T09:22:07Z" },
  { sha: "bbbbbbb2222", repo: "me/two", date: "2024-06-02T18:45:00Z" },
  { sha: "ccccccc3333", repo: "me/two", date: "2025-01-15T04:05:06Z" },
];

const EXPECTED_AT_PLUS_5 = [
  "2024-03-11T14:22:07+05:00",
  "2024-06-02T23:45:00+05:00",
  "2025-01-15T09:05:06+05:00",
];

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "gh-syncer-"));
}

test("shq single-quotes and escapes embedded quotes", () => {
  assert.equal(shq("plain"), "'plain'");
  assert.equal(shq("O'Brien"), "'O'\\''Brien'");
});

test("commitEnv sets author and committer to the same identity and date", () => {
  const e = commitEnv("Me", "me@example.com", "2024-03-11T14:22:07+05:00");
  assert.equal(e.GIT_AUTHOR_DATE, e.GIT_COMMITTER_DATE);
  assert.equal(e.GIT_AUTHOR_EMAIL, "me@example.com");
  assert.equal(e.GIT_COMMITTER_NAME, "Me");
});

test("replay writes commits whose author dates match the converted timestamps exactly", () => {
  const base = scratch();
  try {
    const dir = join(base, "replica");
    replay(FIXTURE, { dir, name: "Me", email: "me@example.com", offset: "+05:00" });
    const log = execFileSync("git", ["-C", dir, "log", "--reverse", "--format=%aI|%cI|%an|%ae|%s"], {
      encoding: "utf8",
    }).trim().split("\n");
    assert.equal(log.length, 3);
    assert.deepEqual(log.map((l) => l.split("|")[0]), EXPECTED_AT_PLUS_5);
    assert.deepEqual(log.map((l) => l.split("|")[1]), EXPECTED_AT_PLUS_5, "committer dates match author dates");
    assert.equal(log[0].split("|")[3], "me@example.com");
    assert.equal(log[0].split("|")[4], "sync aaaaaaa");
    const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(branch, "main");
    const tree = execFileSync("git", ["-C", dir, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(tree, "", "commits are empty");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("replay refuses an existing output directory", () => {
  const base = scratch();
  try {
    const dir = join(base, "replica");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "mine");
    assert.throws(
      () => replay(FIXTURE, { dir, name: "Me", email: "me@example.com", offset: "+05:00" }),
      /already exists/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the rendered script produces byte-identical history to a direct replay", () => {
  const base = scratch();
  try {
    const o: ReplayOpts = { dir: join(base, "from-script"), name: "Me", email: "me@example.com", offset: "+05:00" };
    const path = join(base, "replay.sh");
    writeFileSync(path, renderScript(FIXTURE, o));
    execFileSync("bash", [path], { encoding: "utf8" });
    const dates = execFileSync("git", ["-C", o.dir, "log", "--reverse", "--format=%aI"], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.deepEqual(dates, EXPECTED_AT_PLUS_5);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test.ts`
Expected: FAIL — `replay`, `renderScript`, `shq`, `commitEnv` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `github-syncer.ts`. Add the two imports at the top of the file rather than mid-file:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
```

Then:

```ts
export interface ReplayOpts {
  dir: string;
  name: string;
  email: string;
  offset: string;
}

export function shq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function commitEnv(name: string, email: string, date: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
}

export function replay(commits: Commit[], o: ReplayOpts): void {
  if (existsSync(o.dir)) throw new Error(`${o.dir} already exists — refusing to append to it`);
  execFileSync("git", ["init", "-q", "-b", "main", o.dir]);
  let n = 0;
  for (const c of commits) {
    const date = toOffset(c.date, o.offset);
    execFileSync(
      "git",
      ["-C", o.dir, "commit", "--allow-empty", "-q", "-m", `sync ${c.sha.slice(0, 7)}`],
      { env: { ...process.env, ...commitEnv(o.name, o.email, date) } },
    );
    if (++n % 100 === 0) console.log(`  ${n}/${commits.length} commits`);
  }
}

export function renderScript(commits: Commit[], o: ReplayOpts): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -e",
    `git init -q -b main ${shq(o.dir)}`,
    "",
  ];
  for (const c of commits) {
    const date = toOffset(c.date, o.offset);
    lines.push(
      `GIT_AUTHOR_NAME=${shq(o.name)} GIT_AUTHOR_EMAIL=${shq(o.email)} GIT_AUTHOR_DATE=${shq(date)} \\`,
      `GIT_COMMITTER_NAME=${shq(o.name)} GIT_COMMITTER_EMAIL=${shq(o.email)} GIT_COMMITTER_DATE=${shq(date)} \\`,
      `  git -C ${shq(o.dir)} commit --allow-empty -q -m ${shq(`sync ${c.sha.slice(0, 7)}`)}`,
    );
  }
  lines.push("", `echo 'created ${commits.length} commits in ${o.dir}'`, "");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test.ts`
Expected: PASS, 28 tests. If the `%aI` assertions fail, the bug is in `toOffset`, not in git — re-read the Task 1 tests.

- [ ] **Step 5: Commit**

```bash
git add github-syncer.ts test.ts
git commit -m "Add commit replay and replay.sh rendering"
```

---

### Task 5: Interactive shell

The nine prompts and the `main()` that wires everything together. This is the only untested code in the project; it is kept deliberately thin, with all logic already living in the tested functions above.

**Files:**
- Modify: `github-syncer.ts` (append)
- Test: `test.ts` (append — validator coverage only)
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `main(): Promise<void>` (not exported; invoked only on direct run).

- [ ] **Step 1: Write the failing test**

The prompts themselves are not tested. What is tested is that importing the module does not start the interactive flow — otherwise `node --test` would hang forever waiting on stdin.

Append to `test.ts`:

```ts
test("importing the module does not start the interactive flow", async () => {
  // If main() ran on import, this test file would already have blocked on a prompt.
  const mod = await import("./github-syncer.ts");
  assert.equal(typeof mod.collectCommits, "function");
  assert.equal("main" in mod, false, "main stays module-private");
});
```

- [ ] **Step 2: Run the test to verify it passes for the wrong reason**

Run: `node --test test.ts`
Expected: PASS — there is no `main()` yet, so nothing can run on import. Keep this test; it is the guard that fails in Step 4 if the entry guard is written incorrectly.

- [ ] **Step 3: Write the implementation**

Add to the top imports of `github-syncer.ts`:

```ts
import { createInterface, type Interface } from "node:readline/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
```

Append to `github-syncer.ts`:

```ts
const CACHE = "commits.json";

function gitConfig(key: string): string {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function ask(rl: Interface, q: string, def = ""): Promise<string> {
  const answer = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return answer || def;
}

async function askValid(rl: Interface, q: string, def: string, ok: (s: string) => boolean): Promise<string> {
  for (;;) {
    const a = await ask(rl, q, def);
    if (ok(a)) return a;
    console.log("  invalid, try again");
  }
}

async function askRequired(rl: Interface, q: string, def: string): Promise<string> {
  for (;;) {
    const a = await ask(rl, q, def);
    if (a) return a;
    console.log("  required");
  }
}

async function askYes(rl: Interface, q: string, defYes: boolean): Promise<boolean> {
  const a = (await ask(rl, `${q} (y/n)`, defYes ? "y" : "n")).toLowerCase();
  return a.startsWith("y");
}

async function askSecret(rl: Interface, q: string): Promise<string> {
  // ponytail: _writeToOutput is a private readline field. It is the only way to mute
  // echo without a dependency; if a Node upgrade breaks it, the fallback is to require
  // GITHUB_TOKEN in the environment and drop this prompt.
  const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = iface._writeToOutput;
  stdout.write(`${q}: `);
  iface._writeToOutput = () => {};
  try {
    const value = (await rl.question("")).trim();
    stdout.write("\n");
    return value;
  } finally {
    iface._writeToOutput = original;
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    console.log("github-syncer — replicate one account's commit history as empty commits\n");

    const token = process.env.GITHUB_TOKEN || (await askSecret(rl, "Source GitHub token"));
    if (!token) throw new Error("a token is required");

    let commits: Commit[] | null = null;
    if (existsSync(CACHE)) {
      const cached = JSON.parse(readFileSync(CACHE, "utf8")) as Commit[];
      const when = statSync(CACHE).mtime.toISOString().slice(0, 16).replace("T", " ");
      if (await askYes(rl, `Reuse ${CACHE} (${cached.length} commits, fetched ${when})?`, true)) {
        commits = cached;
      }
    }

    if (!commits) {
      const since = await askValid(rl, "Since date (YYYY-MM-DD)", isoDaysAgo(365), isDate);
      const until = await askValid(rl, "Until date (YYYY-MM-DD)", isoDaysAgo(0), isDate);
      console.log("\nfetching...");
      commits = await collectCommits(token, since, until);
      writeFileSync(CACHE, `${JSON.stringify(commits, null, 2)}\n`);
      console.log(`\ncached ${commits.length} commits to ${CACHE}`);
    }

    if (commits.length === 0) {
      console.log("no commits in that range — nothing to do");
      return;
    }

    const offset = await askValid(
      rl,
      "Replay timezone offset (the zone you did the work in)",
      localOffset(),
      isOffset,
    );
    const name = await askRequired(rl, "Destination author name", gitConfig("user.name"));
    console.log("  note: this email must be a VERIFIED email on the destination account,");
    console.log("  or GitHub will attribute the commits to nobody and the graph stays empty.");
    const email = await askRequired(rl, "Destination author email", gitConfig("user.email"));
    const dir = await askRequired(rl, "Output directory", "./replica");
    const commitNow = await askYes(rl, "Commit now? (n = only write replay.sh)", true);

    const opts: ReplayOpts = { dir, name, email, offset };
    console.log("\n--- summary ---");
    console.log(`commits:  ${commits.length}`);
    console.log(`range:    ${toOffset(commits[0].date, offset)} .. ${toOffset(commits.at(-1)!.date, offset)}`);
    console.log(`identity: ${name} <${email}>`);
    console.log(`target:   ${dir}${commitNow ? "" : "  (via replay.sh)"}`);
    console.log("---------------\n");
    if (!(await askYes(rl, "Proceed?", false))) {
      console.log("aborted, nothing written");
      return;
    }

    if (commitNow) {
      replay(commits, opts);
      console.log(`\ncreated ${commits.length} commits in ${dir}`);
    } else {
      writeFileSync("replay.sh", renderScript(commits, opts));
      console.log(`\nwrote replay.sh — review it, then: bash replay.sh`);
      return;
    }

    console.log("\npush it:");
    console.log(`  cd ${dir}`);
    console.log("  git remote add origin git@github.com:<you>/<repo>.git");
    console.log("  git push -u origin main");
  } finally {
    rl.close();
  }
}

// ponytail: argv[1] comparison is the entry guard. Good enough for `node github-syncer.ts`;
// a symlinked bin wrapper would need realpath here.
if (import.meta.filename === process.argv[1]) await main();
```

- [ ] **Step 4: Run the tests to verify nothing hangs**

Run: `node --test test.ts`
Expected: PASS, 29 tests, and the run terminates. If it hangs, the entry guard is wrong — `main()` is executing on import.

- [ ] **Step 5: Smoke-test the real flow**

Run: `node github-syncer.ts`

At the prompts: accept the token from the environment (or paste one), take the default dates, and answer **n** at `Proceed?`. Expected: it fetches, writes `commits.json`, prints the summary, then reports `aborted, nothing written` and creates no `replica/`.

Run it a second time. Expected: it offers to reuse `commits.json` instead of calling the API.

- [ ] **Step 6: Write `README.md`**

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add github-syncer.ts test.ts README.md
git commit -m "Add interactive prompts and main flow"
```

---

## Done when

- `node --test test.ts` passes, 29 tests.
- `node github-syncer.ts` fetches a real account, caches `commits.json`, and aborts cleanly at `Proceed? n`.
- Answering `y` builds a `replica/` whose `git log --format=%aI` matches the source commit dates converted to the chosen offset.
- `node_modules/` does not exist.
