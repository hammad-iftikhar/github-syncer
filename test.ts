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

test("ghGet handles malformed x-ratelimit-reset with a safe fallback", async () => {
  const calls: string[] = [];
  let slept = 0;
  const f: Fetcher = async () => {
    calls.push("call");
    return calls.length === 1
      ? jsonRes({ message: "rate limited" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" }, 403)
      : jsonRes([{ ok: true }]);
  };
  const res = await ghGet("https://api.github.com/user", "t", f, async (ms) => { slept = ms; });
  assert.equal(calls.length, 2);
  assert.equal(res.status, 200);
  assert.ok(slept >= 1_000, `slept ${slept}`);
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

test("paginate rejects a 404 that arrives after a page already succeeded, instead of truncating silently", async () => {
  const f: Fetcher = async (url) =>
    url.includes("page=2")
      ? jsonRes({ message: "Not Found" }, {}, 404)
      : jsonRes([{ id: 1 }], { link: '<https://api.github.com/r?page=2>; rel="next"' });
  await assert.rejects(() => paginate("https://api.github.com/r", "t", f), /404/);
});

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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay, renderScript, shq, commitEnv, type ReplayOpts } from "./github-syncer.ts";

const FIXTURE: Commit[] = [
  { sha: "aaaaaaa1111", repo: "me/one", date: "2024-03-11T09:22:07Z" },
  { sha: "bbbbbbb2222", repo: "me/two", date: "2024-06-02T18:45:00Z" },
  // Crosses the day boundary at +05:00 (2024-06-02T20:30:00Z -> 2024-06-03T01:30:00+05:00).
  // This is the one property the whole tool exists to deliver — which calendar square a
  // commit lands on — and until this fixture entry it was never verified through real git
  // objects, only through the toOffset unit tests.
  { sha: "ddddddd4444", repo: "me/two", date: "2024-06-02T20:30:00Z" },
  { sha: "ccccccc3333", repo: "me/two", date: "2025-01-15T04:05:06Z" },
];

const EXPECTED_AT_PLUS_5 = [
  "2024-03-11T14:22:07+05:00",
  "2024-06-02T23:45:00+05:00",
  "2024-06-03T01:30:00+05:00",
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
    assert.equal(log.length, 4);
    assert.deepEqual(log.map((l) => l.split("|")[0]), EXPECTED_AT_PLUS_5);
    assert.deepEqual(log.map((l) => l.split("|")[1]), EXPECTED_AT_PLUS_5, "committer dates match author dates");
    assert.equal(log[0].split("|")[3], "me@example.com");
    assert.equal(log[0].split("|")[4], "sync aaaaaaa");
    const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(branch, "main");
    const tree = execFileSync("git", ["-C", dir, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(tree, "", "commits are empty");
    // The one property this product exists to deliver: which calendar square a commit
    // lands on. A 2024-06-02T20:30:00Z author date at +05:00 is local 2024-06-03T01:30,
    // so it must land on the 2024-06-03 square, not 2024-06-02.
    const localDays = execFileSync(
      "git",
      ["-C", dir, "log", "--reverse", "--date=format:%Y-%m-%d", "--format=%ad"],
      { encoding: "utf8" },
    ).trim().split("\n");
    assert.deepEqual(localDays, ["2024-03-11", "2024-06-02", "2024-06-03", "2025-01-15"]);
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

test("renderScript's generated script writes commits whose author dates match the converted timestamps exactly", () => {
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

test("renderScript escapes a single quote in the output directory path everywhere it appears", () => {
  const o: ReplayOpts = { dir: "/tmp/it's here", name: "Me", email: "me@example.com", offset: "+05:00" };
  const script = renderScript(FIXTURE, o);
  assert.ok(script.includes("it'\\''s"), "the quote in the path is escaped the way shq() escapes it");
  assert.ok(!script.includes("it's here"), "no unescaped single quote reaches the script");
});

test("renderScript's guard line refuses an existing output directory before git init runs", () => {
  const o: ReplayOpts = { dir: "/tmp/it's here", name: "Me", email: "me@example.com", offset: "+05:00" };
  const script = renderScript(FIXTURE, o);
  const lines = script.split("\n");
  const guardIndex = lines.findIndex((l) => l.startsWith("test -e "));
  const initIndex = lines.findIndex((l) => l.includes("git init"));
  assert.ok(guardIndex !== -1, "a guard line exists");
  assert.ok(guardIndex < initIndex, "the guard runs before git init");
  assert.ok(lines[guardIndex].includes(shq(o.dir)), "the guarded path went through shq");
  assert.ok(lines[guardIndex].includes("exit 1"), "the guard exits non-zero on a match");
  assert.ok(!lines[guardIndex].includes("it's here"), "no unescaped single quote reaches the guard line");
});

test("importing the module does not start the interactive flow", async () => {
  // If main() ran on import, this test file would already have blocked on a prompt.
  const mod = await import("./github-syncer.ts");
  assert.equal(typeof mod.collectCommits, "function");
  assert.equal("main" in mod, false, "main stays module-private");
});
