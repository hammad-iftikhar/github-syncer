import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitEnv,
  fetchCalendar,
  ghGraphQL,
  isDate,
  isOffset,
  localOffset,
  offsetMinutes,
  renderScript,
  replay,
  shq,
  synthesize,
  toOffset,
  yearWindows,
  type Day,
  type Entry,
  type Fetcher,
  type ReplayOpts,
} from "./github-syncer.ts";

function jsonRes(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "gh-syncer-"));
}

// --- timestamp conversion ---

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

test("offsetMinutes signs both directions", () => {
  assert.equal(offsetMinutes("+05:30"), 330);
  assert.equal(offsetMinutes("-08:00"), -480);
  assert.throws(() => offsetMinutes("nope"), /offset/);
});

test("localOffset formats a whole-hour zone", () => {
  assert.equal(localOffset(new Date("2024-03-11T00:00:00Z")).match(/^[+-]\d{2}:\d{2}$/) !== null, true);
});

test("isDate accepts YYYY-MM-DD and rejects anything else", () => {
  assert.equal(isDate("2024-03-11"), true);
  assert.equal(isDate("2024-3-1"), false);
  assert.equal(isDate("2024-02-30"), false, "a rolled-over date is not a date");
  assert.equal(isDate("2026-06-31"), false);
  assert.equal(isDate("11-03-2024"), false);
  assert.equal(isDate(""), false);
});

test("isOffset accepts signed HH:MM only", () => {
  assert.equal(isOffset("+05:00"), true);
  assert.equal(isOffset("-05:30"), true);
  assert.equal(isOffset("05:00"), false);
  assert.equal(isOffset("+5:00"), false);
  assert.equal(isOffset("+99:99"), false, "git records a bogus zone for this");
  assert.equal(isOffset("+15:00"), false, "no real zone is past +14:00");
  assert.equal(isOffset("+05:45"), true, "Nepal");
  assert.equal(isOffset("+05:20"), false, "not a real quarter-hour zone");
});

// --- the contribution calendar ---

test("yearWindows pads the range by a day at each end", () => {
  const w = yearWindows("2026-01-01", "2026-06-30");
  assert.equal(w.length, 1);
  assert.equal(w[0].from, "2025-12-31T00:00:00.000Z");
  assert.equal(w[0].to, "2026-07-01T23:59:59.000Z");
});

test("yearWindows rejects a reversed range", () => {
  assert.throws(() => yearWindows("2026-09-03", "2023-05-10"), /after/);
});

test("every date in range is fully interior to some window, contributions' offsets included", () => {
  // This is the property that makes fetchCalendar's Math.max correct. from/to filter by
  // instant while the calendar buckets by local date, and an offset reaches 14h from UTC,
  // so a date's contributions span its UTC day plus 14h on each side. Some single window
  // must contain that whole span, or that date can only ever be seen partially.
  const SPAN = 14 * 3_600_000;
  for (const [since, until] of [
    ["2026-09-03", "2026-09-03"],
    ["2025-09-03", "2026-09-03"],
    ["2023-05-10", "2026-09-03"],
    ["2016-01-01", "2026-09-03"],
  ]) {
    const windows = yearWindows(since, until).map((w) => ({
      from: Date.parse(w.from),
      to: Date.parse(w.to),
    }));
    for (const w of windows) {
      assert.ok(w.to - w.from <= 364 * 86_400_000, "each window stays inside the API's one-year cap");
    }
    for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 86_400_000) {
      const lo = t - SPAN;
      const hi = t + 86_400_000 - 1000 + SPAN;
      const covered = windows.some((w) => w.from <= lo && w.to >= hi);
      assert.ok(covered, `${new Date(t).toISOString().slice(0, 10)} is not wholly inside any window`);
    }
  }
});

test("ghGraphQL throws on an errors array inside a 200 response", async () => {
  const f: Fetcher = async () => jsonRes({ errors: [{ message: "Bad credentials" }] });
  await assert.rejects(() => ghGraphQL("q", {}, "t", f), /Bad credentials/);
});

test("ghGraphQL throws on a non-ok response", async () => {
  const f: Fetcher = async () => jsonRes({ message: "nope" }, {}, 401);
  await assert.rejects(() => ghGraphQL("q", {}, "t", f), /401/);
});

test("ghGraphQL posts the query and bearer token", async () => {
  let seenAuth: string | undefined;
  let seenBody: string | undefined;
  const f: Fetcher = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
    seenBody = init?.body as string;
    assert.equal(init?.method, "POST");
    return jsonRes({ data: { viewer: { login: "me" } } });
  };
  await ghGraphQL("query{x}", { from: "a", to: "b" }, "tok123", f);
  assert.equal(seenAuth, "Bearer tok123");
  assert.deepEqual(JSON.parse(seenBody!), { query: "query{x}", variables: { from: "a", to: "b" } });
});

function calendarRes(days: { date: string; contributionCount: number }[], restricted = 0): Response {
  return jsonRes({
    data: {
      viewer: {
        login: "me",
        contributionsCollection: {
          restrictedContributionsCount: restricted,
          contributionCalendar: {
            totalContributions: days.reduce((n, d) => n + d.contributionCount, 0),
            weeks: [{ contributionDays: days }],
          },
        },
      },
    },
  });
}

test("fetchCalendar keeps only active in-range days, sorted, and reports the login", async () => {
  const f: Fetcher = async () =>
    calendarRes([
      { date: "2026-09-02", contributionCount: 3 },
      { date: "2026-09-01", contributionCount: 22 },
      { date: "2026-08-31", contributionCount: 0 },
      { date: "2026-12-25", contributionCount: 9 },
    ]);
  const { login, days } = await fetchCalendar("t", "2026-09-01", "2026-09-30", f);
  assert.equal(login, "me");
  assert.deepEqual(days, [
    { date: "2026-09-01", count: 22 },
    { date: "2026-09-02", count: 3 },
  ]);
});

test("a date seen partially at a window seam takes its full count from the other window", async () => {
  // The bug this guards: contributionsCollection filters by instant, so a date lying on a
  // seam comes back with only part of its contributions. Windows overlap by two days so
  // that date is also returned whole by the neighbouring window, and Math.max must take
  // the whole one. Keeping the partial would silently undercount that square.
  //
  // The stub answers according to the window it is actually handed — a full count only
  // when the date's whole instant span (its UTC day plus 14h either side) is inside the
  // window, a partial otherwise. That is what makes this test fail against windows that
  // do not overlap: there, no window holds the seam date whole, so 4 is all it can see.
  const SPAN = 14 * 3_600_000;
  const dayStart = Date.parse("2026-09-01T00:00:00Z");
  const dayEnd = dayStart + 86_400_000 - 1000;
  let calls = 0;
  const f: Fetcher = async (_url, init) => {
    calls++;
    const { variables } = JSON.parse(init!.body as string) as { variables: { from: string; to: string } };
    const whole =
      Date.parse(variables.from) <= dayStart - SPAN && Date.parse(variables.to) >= dayEnd + SPAN;
    return calendarRes([{ date: "2026-09-01", contributionCount: whole ? 13 : 4 }]);
  };
  const { days } = await fetchCalendar("t", "2025-09-03", "2026-09-03", f);
  assert.ok(calls >= 2, `expected more than one window, got ${calls}`);
  assert.deepEqual(days, [{ date: "2026-09-01", count: 13 }]);
});

test("fetchCalendar warns but still returns days when a window's total disagrees with its days", async () => {
  // The integrity check: the API reports each window's own total, so a mismatch means the
  // calendar was parsed wrong — which would otherwise surface as a quietly short replica.
  const f: Fetcher = async () =>
    jsonRes({
      data: {
        viewer: {
          login: "me",
          contributionsCollection: {
            restrictedContributionsCount: 0,
            contributionCalendar: {
              totalContributions: 99,
              weeks: [{ contributionDays: [{ date: "2026-09-01", contributionCount: 5 }] }],
            },
          },
        },
      },
    });
  const errs: string[] = [];
  const original = console.error;
  console.error = (m: string) => errs.push(m);
  try {
    const { days } = await fetchCalendar("t", "2026-09-01", "2026-09-02", f);
    assert.deepEqual(days, [{ date: "2026-09-01", count: 5 }]);
  } finally {
    console.error = original;
  }
  assert.ok(errs.some((e) => e.includes("99") && e.includes("5")), `expected a mismatch warning, got ${errs}`);
});

// --- synthesising commits from counts ---

test("synthesize emits one entry per contribution", () => {
  const days: Day[] = [
    { date: "2026-09-01", count: 22 },
    { date: "2026-09-02", count: 1 },
  ];
  const entries = synthesize(days, "+05:00");
  assert.equal(entries.length, 23);
  assert.equal(entries[0].id, "2026-09-01#1");
  assert.equal(entries[21].id, "2026-09-01#22");
  assert.equal(entries[22].id, "2026-09-02#1");
});

test("every synthesized entry lands on its own calendar day, in every offset", () => {
  // The invariant the whole tool rests on: 22 contributions on 2026-09-01 must produce 22
  // commits whose local author date is 2026-09-01 — not one spilling either side.
  const days: Day[] = [
    { date: "2026-09-01", count: 22 },
    { date: "2026-01-01", count: 1 },
    { date: "2026-12-31", count: 5 },
    { date: "2026-06-15", count: 300 },
  ];
  for (const offset of ["+00:00", "+05:00", "+05:30", "-08:00", "+14:00", "-11:00"]) {
    for (const entry of synthesize(days, offset)) {
      const local = toOffset(entry.date, offset);
      const day = entry.id.split("#")[0];
      assert.equal(local.slice(0, 10), day, `${entry.id} at ${offset} landed on ${local}`);
    }
  }
});

test("synthesize keeps a very busy day inside working hours", () => {
  const entries = synthesize([{ date: "2026-09-01", count: 300 }], "+05:00");
  const hours = entries.map((e) => Number(toOffset(e.date, "+05:00").slice(11, 13)));
  assert.ok(Math.min(...hours) >= 9, `earliest hour ${Math.min(...hours)}`);
  assert.ok(Math.max(...hours) <= 22, `latest hour ${Math.max(...hours)}`);
});

test("synthesize returns nothing for no days", () => {
  assert.deepEqual(synthesize([], "+05:00"), []);
});

test("synthesize rejects a malformed date", () => {
  assert.throws(() => synthesize([{ date: "nope", count: 1 }], "+05:00"), /date/);
});

// --- replay ---

const FIXTURE: Entry[] = [
  { id: "2024-03-11#1", date: "2024-03-11T09:22:07Z" },
  { id: "2024-06-02#1", date: "2024-06-02T18:45:00Z" },
  // Crosses the day boundary at +05:00 (2024-06-02T20:30:00Z -> 2024-06-03T01:30:00+05:00).
  // Which calendar square a commit lands on is the one property this product delivers, so
  // it is verified here through real git objects, not only through toOffset unit tests.
  { id: "2024-06-03#1", date: "2024-06-02T20:30:00Z" },
  { id: "2025-01-15#1", date: "2025-01-15T04:05:06Z" },
];

const EXPECTED_AT_PLUS_5 = [
  "2024-03-11T14:22:07+05:00",
  "2024-06-02T23:45:00+05:00",
  "2024-06-03T01:30:00+05:00",
  "2025-01-15T09:05:06+05:00",
];

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
    })
      .trim()
      .split("\n");
    assert.equal(log.length, 4);
    assert.deepEqual(log.map((l) => l.split("|")[0]), EXPECTED_AT_PLUS_5);
    assert.deepEqual(log.map((l) => l.split("|")[1]), EXPECTED_AT_PLUS_5, "committer dates match author dates");
    assert.equal(log[0].split("|")[3], "me@example.com");
    assert.equal(log[0].split("|")[4], "contribution 2024-03-11#1");
    const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "main");
    const tree = execFileSync("git", ["-C", dir, "show", "--stat", "--format=", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(tree, "", "commits are empty");
    // The property this product exists to deliver: which calendar square each commit
    // lands on, read back out of git the way GitHub's graph reads it.
    const localDays = execFileSync(
      "git",
      ["-C", dir, "log", "--reverse", "--date=format:%Y-%m-%d", "--format=%ad"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.deepEqual(localDays, ["2024-03-11", "2024-06-02", "2024-06-03", "2025-01-15"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a day's worth of contributions all land on that day's square in real git objects", () => {
  // End to end: 22 counted contributions on 2026-09-01 become 22 commits, every one of
  // them on the 2026-09-01 square.
  const base = scratch();
  try {
    const dir = join(base, "replica");
    const entries = synthesize([{ date: "2026-09-01", count: 22 }], "+05:00");
    replay(entries, { dir, name: "Me", email: "me@example.com", offset: "+05:00" });
    const localDays = execFileSync(
      "git",
      ["-C", dir, "log", "--date=format:%Y-%m-%d", "--format=%ad"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.equal(localDays.length, 22);
    assert.deepEqual([...new Set(localDays)], ["2026-09-01"]);
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

test("the generated script commits into whatever directory it is run from", () => {
  const base = scratch();
  try {
    const script = join(base, "replay.sh");
    const target = join(base, "somewhere-else");
    mkdirSync(target);
    writeFileSync(script, renderScript(FIXTURE, { name: "Me", email: "me@example.com", offset: "+05:00" }));
    // cwd is the target: the script names no directory, so this is what decides where
    // the commits land.
    execFileSync("bash", [script], { cwd: target, encoding: "utf8" });
    const dates = execFileSync("git", ["-C", target, "log", "--reverse", "--format=%aI"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.deepEqual(dates, EXPECTED_AT_PLUS_5, "same author dates as a direct replay");
    const branch = execFileSync("git", ["-C", target, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "main");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("running the generated script twice does not double the history", () => {
  // git init on an existing repo succeeds, so without the HEAD guard a second run would
  // append a whole second copy and exit 0 — a silently doubled contribution graph.
  const base = scratch();
  try {
    const script = join(base, "replay.sh");
    const target = join(base, "twice");
    mkdirSync(target);
    writeFileSync(script, renderScript(FIXTURE, { name: "Me", email: "me@example.com", offset: "+05:00" }));
    execFileSync("bash", [script], { cwd: target, encoding: "utf8" });
    let failed = false;
    try {
      execFileSync("bash", [script], { cwd: target, encoding: "utf8", stdio: "pipe" });
    } catch {
      failed = true;
    }
    assert.ok(failed, "the second run exits non-zero");
    const count = execFileSync("git", ["-C", target, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(count, String(FIXTURE.length), "no commits were added by the second run");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the generated script refuses a directory that is part of an existing repository", () => {
  const base = scratch();
  try {
    const script = join(base, "replay.sh");
    const repo = join(base, "existing");
    execFileSync("git", ["init", "-q", "-b", "main", "--", repo]);
    execFileSync(
      "git",
      ["-C", repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "theirs"],
      { env: { ...process.env, ...commitEnv("Them", "them@example.com", "2020-01-01T00:00:00+00:00") } },
    );
    writeFileSync(script, renderScript(FIXTURE, { name: "Me", email: "me@example.com", offset: "+05:00" }));
    let failed = false;
    try {
      execFileSync("bash", [script], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    } catch {
      failed = true;
    }
    assert.ok(failed, "it refuses rather than committing into someone else's history");
    const count = execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(count, "1", "their history is untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renderScript escapes a single quote in the author identity", () => {
  // The directory is gone from the script, so the identity is now what a quote can break.
  const script = renderScript(FIXTURE, { name: "O'Brien", email: "o'b@example.com", offset: "+05:00" });
  assert.ok(script.includes("'O'\\''Brien'"), "the name's quote is escaped the way shq() escapes it");
  assert.ok(!script.includes("=O'Brien"), "no unescaped single quote reaches the script");
  assert.ok(script.includes("'o'\\''b@example.com'"), "the email's quote is escaped too");
});

test("the generated script names no directory at all", () => {
  const script = renderScript(FIXTURE, { name: "Me", email: "me@example.com", offset: "+05:00" });
  assert.ok(!script.includes("git -C "), "no -C flag: the cwd decides where commits land");
  assert.ok(/^\s*git init -q -b main$/m.test(script), "git init takes no directory either");
});

test("the generated script unsets the git env vars that would redirect the commits", () => {
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in the shell running replay.sh override the
  // working tree, so without this the whole replayed history lands elsewhere.
  const lines = renderScript(FIXTURE, { name: "Me", email: "me@example.com", offset: "+05:00" }).split("\n");
  const unsetIndex = lines.findIndex((l) => l.startsWith("unset "));
  assert.ok(unsetIndex !== -1, "an unset line exists");
  for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    assert.ok(lines[unsetIndex].includes(v), `${v} is unset`);
  }
  assert.ok(unsetIndex < lines.findIndex((l) => l.includes("git init")), "it runs before git init");
});

test("importing the module does not start the interactive flow", async () => {
  // If main() ran on import, this test file would already have blocked on a prompt.
  const mod = await import("./github-syncer.ts");
  assert.equal(typeof mod.fetchCalendar, "function");
  assert.equal("main" in mod, false, "main stays module-private");
});
