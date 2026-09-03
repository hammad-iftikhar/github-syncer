import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";

export function toOffset(utcIso: string, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset: ${offset}`);
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${utcIso}`);
  const sign = m[1] === "-" ? -1 : 1;
  const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date(ms + minutes * 60_000);
  return shifted.toISOString().slice(0, 19) + offset;
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
    const resetSec = Number(res.headers.get("x-ratelimit-reset"));
    const wait = Number.isFinite(resetSec)
      ? Math.max(1_000, resetSec * 1_000 - Date.now() + 1_000)
      : 60_000;
    console.error(`rate limit hit, sleeping ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

export async function paginate<T>(url: string, token: string, f: Fetcher = fetch): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  // ponytail: no cycle guard. GitHub generates these Link headers, so a
  // self-referential `next` would be its bug; add a visited-set if this
  // ever talks to another API.
  while (next) {
    const res = await ghGet(next, token, f);
    // 409 = empty repo, 404 = access lost between listing and reading. Neither is fatal,
    // but only on the first page — a 404/409 after we already have results means access
    // was lost mid-pagination, and returning what we have so far would silently truncate.
    if ((res.status === 409 || res.status === 404) && out.length === 0) return out;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${next}`);
    out.push(...((await res.json()) as T[]));
    next = nextLink(res.headers.get("link"));
  }
  return out;
}

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
  const scopes = res.headers.get("x-oauth-scopes");
  if (scopes) {
    if (!scopes.split(",").map((s) => s.trim()).includes("repo")) {
      console.error(
        "warning: this token's scopes do not include `repo` — private repositories will be invisible to it, so the replica will be incomplete.",
      );
    }
  } else {
    console.error(
      "warning: token scopes could not be verified (fine-grained tokens don't report them) — confirm this token can read your private repos.",
    );
  }
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

// ponytail: no resume. A replay that dies partway leaves a partial repo and the
// only recovery is `rm -rf` and rerun; commits are empty so regenerating is cheap
// and commits.json is already cached. Add resume if a real replay ever dies.
export function replay(commits: Commit[], o: ReplayOpts): void {
  if (existsSync(o.dir)) throw new Error(`${o.dir} already exists — refusing to append to it`);
  execFileSync("git", ["init", "-q", "-b", "main", "--", o.dir]);
  let n = 0;
  for (const c of commits) {
    const date = toOffset(c.date, o.offset);
    execFileSync(
      "git",
      ["-C", o.dir, ...SAFE_GIT_CONFIG, "commit", "--allow-empty", "-q", "-m", `sync ${c.sha.slice(0, 7)}`],
      { env: { ...process.env, ...commitEnv(o.name, o.email, date) } },
    );
    if (++n % 100 === 0) console.log(`  ${n}/${commits.length} commits`);
  }
}

export function renderScript(commits: Commit[], o: ReplayOpts): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -e",
    `test -e ${shq(o.dir)} && { echo ${shq(`${o.dir} already exists — refusing to append to it`)} >&2; exit 1; }`,
    `git init -q -b main -- ${shq(o.dir)}`,
    "",
  ];
  for (const c of commits) {
    const date = toOffset(c.date, o.offset);
    lines.push(
      `GIT_AUTHOR_NAME=${shq(o.name)} GIT_AUTHOR_EMAIL=${shq(o.email)} GIT_AUTHOR_DATE=${shq(date)} \\`,
      `GIT_COMMITTER_NAME=${shq(o.name)} GIT_COMMITTER_EMAIL=${shq(o.email)} GIT_COMMITTER_DATE=${shq(date)} \\`,
      `  git -C ${shq(o.dir)} -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --allow-empty -q -m ${shq(`sync ${c.sha.slice(0, 7)}`)}`,
    );
  }
  lines.push("", `echo ${shq(`created ${commits.length} commits in ${o.dir}`)}`, "");
  return lines.join("\n");
}

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
    console.log("github-syncer — replicate one account's commit history as empty commits\n");

    const token = process.env.GITHUB_TOKEN || (await askSecret(rl, "Source GitHub token", signal));
    if (!token) throw new Error("a token is required");

    let commits: Commit[] | null = null;
    if (existsSync(CACHE)) {
      const cached = JSON.parse(readFileSync(CACHE, "utf8")) as Commit[];
      const when = statSync(CACHE).mtime.toISOString().slice(0, 16).replace("T", " ");
      const range =
        cached.length > 0 ? `, ${cached[0].date.slice(0, 10)}..${cached.at(-1)!.date.slice(0, 10)}` : "";
      if (
        await askYes(rl, `Reuse ${CACHE} (${cached.length} commits${range}, fetched ${when})?`, true, signal)
      ) {
        commits = cached;
      }
    }

    if (!commits) {
      const since = await askValid(rl, "Since date (YYYY-MM-DD)", isoDaysAgo(365), isDate, signal);
      const until = await askValid(rl, "Until date (YYYY-MM-DD)", isoDaysAgo(0), isDate, signal);
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
    console.log("\n--- summary ---");
    console.log(`commits:  ${commits.length}`);
    console.log(`range:    ${toOffset(commits[0].date, offset)} .. ${toOffset(commits.at(-1)!.date, offset)}`);
    console.log(`identity: ${name} <${email}>`);
    console.log(`target:   ${dir}${commitNow ? "" : "  (via replay.sh)"}`);
    console.log("---------------\n");
    if (!(await askYes(rl, "Proceed?", false, signal))) {
      console.log("aborted, nothing written");
      return;
    }

    if (commitNow) {
      replay(commits, opts);
      console.log(`\ncreated ${commits.length} commits in ${dir}`);
    } else {
      // replay.sh is always written to the cwd, but `dir` may be relative — resolve it
      // now so the script builds the replica in the right place even if `bash replay.sh`
      // is later run from a different directory.
      writeFileSync("replay.sh", renderScript(commits, { ...opts, dir: resolve(dir) }));
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
