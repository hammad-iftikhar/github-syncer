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
