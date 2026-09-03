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
