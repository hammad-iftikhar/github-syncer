import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";

export function toOffset(utcIso: string, offset: string): string {
  const minutes = offsetMinutes(offset);
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${utcIso}`);
  const shifted = new Date(ms + minutes * 60_000);
  return shifted.toISOString().slice(0, 19) + offset;
}

export function offsetMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset: ${offset}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
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

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** One day of the contribution calendar: the date, and how many contributions it holds. */
export interface Day {
  date: string;
  count: number;
}

/** One commit to replay: a label for its message, and the UTC instant to stamp it with. */
export interface Entry {
  id: string;
  date: string;
}

const GRAPHQL = "https://api.github.com/graphql";

// The contribution calendar IS the graph, so it already counts every activity GitHub
// counts — commits, PRs opened, reviews submitted, issues and discussions opened,
// repositories created and forked. Summing REST endpoints could not match it: a commit
// counts only on a default or gh-pages branch of a non-fork, so squash-merged PR branch
// commits were never on the source graph and must not be replicated.
const CALENDAR_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

interface CalendarBody {
  data?: {
    viewer: {
      login: string;
      contributionsCollection: {
        restrictedContributionsCount: number;
        contributionCalendar: {
          totalContributions: number;
          weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
        };
      };
    };
  };
  errors?: { message: string }[];
}

export async function ghGraphQL(
  query: string,
  variables: Record<string, string>,
  token: string,
  f: Fetcher = fetch,
): Promise<CalendarBody> {
  const res = await f(GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "github-syncer",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} from the GraphQL API — check the token and its scopes`);
  }
  const body = (await res.json()) as CalendarBody;
  // GraphQL reports failures inside a 200 response, so an unchecked errors array would
  // read as "no contributions" — the silent wrongness this tool can least afford.
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("GraphQL returned no data and no errors");
  return body;
}

/**
 * contributionsCollection accepts at most one year per query, so a longer range is walked
 * in windows. 364 days keeps each window strictly inside the cap.
 */
export function yearWindows(since: string, until: string): { from: string; to: string }[] {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T23:59:59Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`bad range: ${since}..${until}`);
  if (start > end) throw new Error(`since ${since} is after until ${until}`);
  const WINDOW = 364 * 86_400_000;
  const out: { from: string; to: string }[] = [];
  for (let from = start; from <= end; ) {
    const to = Math.min(from + WINDOW, end);
    out.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    from = to + 1000;
  }
  return out;
}

export async function fetchCalendar(
  token: string,
  since: string,
  until: string,
  f: Fetcher = fetch,
): Promise<Day[]> {
  const byDate = new Map<string, number>();
  let login = "";
  let restricted = 0;
  for (const window of yearWindows(since, until)) {
    const { viewer } = (await ghGraphQL(CALENDAR_QUERY, window, token, f)).data!;
    login = viewer.login;
    restricted += viewer.contributionsCollection.restrictedContributionsCount;
    for (const week of viewer.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        if (day.contributionCount === 0) continue;
        if (day.date < since || day.date > until) continue;
        // A date can appear in two adjacent windows. Its count is a property of the day,
        // not of the window, so take it once rather than adding it twice.
        byDate.set(day.date, Math.max(byDate.get(day.date) ?? 0, day.contributionCount));
      }
    }
  }
  const days = [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((n, d) => n + d.count, 0);
  console.log(`${total} contributions across ${days.length} active days for ${login}`);
  if (restricted > 0) {
    console.log(`  ${restricted} are in private repositories this token cannot see in detail`);
    console.log("  give the token `repo` scope if that number should be zero");
  }
  return days;
}

/**
 * Turn per-day counts into commits. Each entry is stored as the UTC instant whose local
 * time in `offset` falls on that calendar date, so replay's toOffset() lands it back on
 * exactly the square the source graph had it on.
 */
export function synthesize(days: Day[], offset: string): Entry[] {
  const off = offsetMinutes(offset);
  const out: Entry[] = [];
  for (const day of days) {
    const midnight = Date.parse(`${day.date}T00:00:00Z`);
    if (Number.isNaN(midnight)) throw new Error(`bad date: ${day.date}`);
    for (let i = 0; i < day.count; i++) {
      // ponytail: spread evenly across 09:00-22:00 local so even a day holding hundreds of
      // contributions cannot spill past midnight into the next square. Beyond ~780 in one
      // day the minutes start repeating, which git accepts; widen the window if it matters.
      const minute = 9 * 60 + Math.floor((i * 13 * 60) / day.count);
      const utc = new Date(midnight + (minute - off) * 60_000);
      out.push({ id: `${day.date}#${i + 1}`, date: `${utc.toISOString().slice(0, 19)}Z` });
    }
  }
  return out;
}

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

// Both flags below keep the replay independent of the user's global git config:
// commit.gpgsign=true would otherwise try to launch pinentry with no TTY attached,
// and a global hook could run arbitrary code once per commit.
const SAFE_GIT_CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

// ponytail: no resume. A replay that dies partway leaves a partial repo and the only
// recovery is `rm -rf` and rerun; commits are empty so regenerating is cheap and the
// calendar is already cached. Add resume if a real replay ever dies.
export function replay(entries: Entry[], o: ReplayOpts): void {
  if (existsSync(o.dir)) throw new Error(`${o.dir} already exists — refusing to append to it`);
  execFileSync("git", ["init", "-q", "-b", "main", "--", o.dir]);
  let n = 0;
  for (const e of entries) {
    const date = toOffset(e.date, o.offset);
    execFileSync(
      "git",
      ["-C", o.dir, ...SAFE_GIT_CONFIG, "commit", "--allow-empty", "-q", "-m", `contribution ${e.id}`],
      { env: { ...process.env, ...commitEnv(o.name, o.email, date) } },
    );
    if (++n % 100 === 0) console.log(`  ${n}/${entries.length} commits`);
  }
}

export function renderScript(entries: Entry[], o: ReplayOpts): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -e",
    `test -e ${shq(o.dir)} && { echo ${shq(`${o.dir} already exists — refusing to append to it`)} >&2; exit 1; }`,
    `git init -q -b main -- ${shq(o.dir)}`,
    "",
  ];
  for (const e of entries) {
    const date = toOffset(e.date, o.offset);
    lines.push(
      `GIT_AUTHOR_NAME=${shq(o.name)} GIT_AUTHOR_EMAIL=${shq(o.email)} GIT_AUTHOR_DATE=${shq(date)} \\`,
      `GIT_COMMITTER_NAME=${shq(o.name)} GIT_COMMITTER_EMAIL=${shq(o.email)} GIT_COMMITTER_DATE=${shq(date)} \\`,
      `  git -C ${shq(o.dir)} -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --allow-empty -q -m ${shq(`contribution ${e.id}`)}`,
    );
  }
  lines.push("", `echo ${shq(`created ${entries.length} commits in ${o.dir}`)}`, "");
  return lines.join("\n");
}

const CACHE = "contributions.json";

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

async function ask(rl: Interface, q: string, signal: AbortSignal, def = ""): Promise<string> {
  const answer = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `, { signal })).trim();
  return answer || def;
}

async function askValid(
  rl: Interface,
  q: string,
  def: string,
  ok: (s: string) => boolean,
  signal: AbortSignal,
): Promise<string> {
  for (;;) {
    const a = await ask(rl, q, signal, def);
    if (ok(a)) return a;
    console.log("  invalid, try again");
  }
}

async function askRequired(rl: Interface, q: string, def: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    const a = await ask(rl, q, signal, def);
    if (a) return a;
    console.log("  required");
  }
}

async function askYes(rl: Interface, q: string, defYes: boolean, signal: AbortSignal): Promise<boolean> {
  const a = (await ask(rl, `${q} (y/n)`, signal, defYes ? "y" : "n")).toLowerCase();
  return a.startsWith("y");
}

async function askSecret(rl: Interface, q: string, signal: AbortSignal): Promise<string> {
  // ponytail: _writeToOutput is a private readline field. It is the only way to mute
  // echo without a dependency; if a Node upgrade breaks it, the fallback is to require
  // GITHUB_TOKEN in the environment and drop this prompt.
  const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = iface._writeToOutput;
  stdout.write(`${q}: `);
  iface._writeToOutput = () => {};
  try {
    const value = (await rl.question("", { signal })).trim();
    stdout.write("\n");
    return value;
  } finally {
    iface._writeToOutput = original;
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // ponytail: one AbortController, aborted on the interface's own "close" event —
  // the same event a real Ctrl-D on a TTY fires. Every rl.question() gets the
  // signal so a mid-prompt Ctrl-D rejects cleanly instead of hanging forever.
  const ac = new AbortController();
  rl.once("close", () => ac.abort());
  const { signal } = ac;
  try {
    console.log("github-syncer — replicate one account's contribution graph as empty commits\n");

    const token = process.env.GITHUB_TOKEN || (await askSecret(rl, "Source GitHub token", signal));
    if (!token) throw new Error("a token is required");

    let days: Day[] | null = null;
    if (existsSync(CACHE)) {
      const cached = JSON.parse(readFileSync(CACHE, "utf8")) as Day[];
      const when = statSync(CACHE).mtime.toISOString().slice(0, 16).replace("T", " ");
      const cachedTotal = cached.reduce((n, d) => n + d.count, 0);
      const range = cached.length > 0 ? `, ${cached[0].date}..${cached.at(-1)!.date}` : "";
      if (
        await askYes(
          rl,
          `Reuse ${CACHE} (${cachedTotal} contributions${range}, fetched ${when})?`,
          true,
          signal,
        )
      ) {
        days = cached;
      }
    }

    if (!days) {
      const since = await askValid(rl, "Since date (YYYY-MM-DD)", isoDaysAgo(365), isDate, signal);
      const until = await askValid(rl, "Until date (YYYY-MM-DD)", isoDaysAgo(0), isDate, signal);
      console.log("\nfetching contribution calendar...");
      days = await fetchCalendar(token, since, until);
      writeFileSync(CACHE, `${JSON.stringify(days, null, 2)}\n`);
      console.log(`cached ${days.length} active days to ${CACHE}`);
    }

    const total = days.reduce((n, d) => n + d.count, 0);
    if (total === 0) {
      console.log("no contributions in that range — nothing to do");
      return;
    }

    const offset = await askValid(
      rl,
      "Timezone offset to stamp the commits with",
      localOffset(),
      isOffset,
      signal,
    );
    const name = await askRequired(rl, "Destination author name", gitConfig("user.name"), signal);
    console.log("  note: this email must be a VERIFIED email on the destination account,");
    console.log("  or GitHub will attribute the commits to nobody and the graph stays empty.");
    const email = await askRequired(rl, "Destination author email", gitConfig("user.email"), signal);
    const dir = await askRequired(rl, "Output directory", "./replica", signal);
    // Checked here — before the summary — rather than only inside replay(), so a user
    // in script mode (which has no directory-exists check of its own) is not asked to
    // confirm a run that is refused right after. See replay()'s own check for its contract.
    if (existsSync(dir)) throw new Error(`${dir} already exists — refusing to append to it`);
    const commitNow = await askYes(rl, "Commit now? (n = only write replay.sh)", true, signal);

    const opts: ReplayOpts = { dir, name, email, offset };
    const entries = synthesize(days, offset);
    const busiest = days.reduce((a, b) => (b.count > a.count ? b : a));
    console.log("\n--- summary ---");
    console.log(`contributions: ${total}  (one empty commit each)`);
    console.log(`active days:   ${days.length}`);
    console.log(`range:         ${days[0].date} .. ${days.at(-1)!.date}`);
    console.log(`busiest day:   ${busiest.date} (${busiest.count})`);
    console.log(`identity:      ${name} <${email}>`);
    console.log(`target:        ${dir}${commitNow ? "" : "  (via replay.sh)"}`);
    console.log("---------------\n");
    if (!(await askYes(rl, "Proceed?", false, signal))) {
      console.log("aborted, nothing written");
      return;
    }

    if (commitNow) {
      replay(entries, opts);
      console.log(`\ncreated ${entries.length} commits in ${dir}`);
    } else {
      // replay.sh is always written to the cwd, but `dir` may be relative — resolve it
      // now so the script builds the replica in the right place even if `bash replay.sh`
      // is later run from a different directory.
      writeFileSync("replay.sh", renderScript(entries, { ...opts, dir: resolve(dir) }));
      console.log(`\nwrote replay.sh — review it, then: bash replay.sh`);
      return;
    }

    console.log("\npush it:");
    console.log(`  cd ${dir}`);
    console.log("  git remote add origin git@github.com:<you>/<repo>.git");
    console.log("  git push -u origin main");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log("\ncancelled, nothing written");
      return;
    }
    throw err;
  } finally {
    rl.close();
  }
}

// ponytail: argv[1] comparison is the entry guard. Good enough for `node github-syncer.ts`;
// a symlinked bin wrapper would need realpath here.
if (import.meta.filename === process.argv[1]) await main();
