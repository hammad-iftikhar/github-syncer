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
