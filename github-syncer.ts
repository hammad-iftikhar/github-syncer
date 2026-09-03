import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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
    // 409 = empty repo, 404 = access lost between listing and reading. Neither is fatal.
    if (res.status === 409 || res.status === 404) return out;
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

// ponytail: no resume. A replay that dies partway leaves a partial repo and the
// only recovery is `rm -rf` and rerun; commits are empty so regenerating is cheap
// and commits.json is already cached. Add resume if a real replay ever dies.
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
  lines.push("", `echo ${shq(`created ${commits.length} commits in ${o.dir}`)}`, "");
  return lines.join("\n");
}
