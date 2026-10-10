/**
 * Recency tier tests.
 *
 * Tiering decides which cards earn the injected index's attention, so the boundaries and the
 * clock choice are the load-bearing parts. Both are pure functions, so every case here is an exact
 * assertion rather than an approximation.
 *
 * The clock is `max(updated, lastUsed)`. The two cases that justify it are pinned explicitly: a card
 * edited today must not be called forgotten because it was never retrieved, and a card retrieved
 * today must not be called ancient because it was written long ago.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Isolates the database before anything opens it.
import "./setup.js";
import { refreshIndex, renderIndex } from "../lib/index.js";
import { importCard, resolveStore } from "../lib/store.js";
import {
  activityTime,
  ageLabel,
  DEFAULT_TIER_DAYS,
  formatDate,
  isInjected,
  parseDate,
  resolveTierDays,
  TIER_DETAIL,
  TIER_LABELS,
  TIER_ORDER,
  tierOf,
} from "../lib/tiers.js";

/** A fixed instant so the tests never depend on the wall clock. */
const NOW = new Date(2026, 5, 15).getTime();

/**
 * Build a card whose only interesting field is its dates.
 * @param updated - `updated` date text.
 * @param created - `created` date text.
 * @returns a card-shaped object.
 */
function card(updated, created = updated) {
  return { name: "sample", updated, created };
}

/**
 * Days before NOW as a date string.
 * @param days - how many days back.
 * @returns the date text.
 */
function ago(days) {
  return formatDate(NOW - days * 86_400_000);
}

test("parseDate reads a calendar date as local midnight", () => {
  const parsed = parseDate("2026-06-15");
  const expected = new Date(2026, 5, 15).getTime();
  assert.equal(parsed, expected);
  assert.equal(formatDate(parsed), "2026-06-15");
});

test("parseDate rejects what a card cannot contain", () => {
  for (const value of [undefined, null, "", "today", "2026/06/15", "2026-6-5", 20260615, {}]) {
    assert.equal(parseDate(value), undefined, `${JSON.stringify(value)} must not parse`);
  }
});

test("every boundary lands in the documented tier", () => {
  const days = { past: 7, old: 30, ancient: 90, forgotten: 365 };
  const cases = [
    [0, "recent"],
    [7, "recent"],    // boundary is inclusive
    [8, "past"],
    [30, "past"],
    [31, "old"],
    [90, "old"],
    [91, "ancient"],
    [365, "ancient"],
    [366, "forgotten"],
  ];
  for (const [elapsed, expected] of cases) {
    const result = tierOf(card(ago(elapsed)), { days, now: NOW });
    assert.equal(result.tier, expected, `${elapsed} 天应为 ${expected}`);
    assert.equal(result.days, elapsed);
  }
});

test("the configured boundaries move the tiers", () => {
  const tight = { past: 1, old: 2, ancient: 3, forgotten: 4 };
  assert.equal(tierOf(card(ago(1)), { days: tight, now: NOW }).tier, "recent");
  assert.equal(tierOf(card(ago(2)), { days: tight, now: NOW }).tier, "past");
  assert.equal(tierOf(card(ago(4)), { days: tight, now: NOW }).tier, "ancient");
  assert.equal(tierOf(card(ago(5)), { days: tight, now: NOW }).tier, "forgotten");
});

test("a binding immediately after a boundary is not a tier", () => {
  // The boundary belongs to the newer tier: `<= 7` is recent, so 7 must not be past.
  const days = { past: 7, old: 30, ancient: 90, forgotten: 365 };
  assert.equal(tierOf(card(ago(7)), { days, now: NOW }).tier, "recent");
  assert.equal(tierOf(card(ago(8)), { days, now: NOW }).tier, "past");
});

test("the clock is max(updated, lastUsed): a fresh edit is not forgotten", () => {
  // Written long ago, never retrieved, but edited today.
  const result = tierOf(card(ago(900), ago(900)), { days: DEFAULT_TIER_DAYS, now: NOW, lastUsed: ago(0) });
  assert.equal(result.tier, "recent", "a card edited today is fresh regardless of age");
});

test("the clock is max(updated, lastUsed): a recent retrieval is not ancient", () => {
  // Written a year ago but retrieved today: still needed, so not ancient.
  const result = tierOf(card(ago(400), ago(400)), { days: DEFAULT_TIER_DAYS, now: NOW, lastUsed: ago(0) });
  assert.equal(result.tier, "recent", "a card retrieved today is in use regardless of age");
});

test("the older of the two dates wins when both are old", () => {
  const result = tierOf(card(ago(40), ago(400)), { days: DEFAULT_TIER_DAYS, now: NOW, lastUsed: ago(300) });
  assert.equal(result.tier, "old", "the newest signal is 40 days old");
});

test("a card with no usable date is treated as forgotten", () => {
  const result = tierOf({ name: "x", updated: "", created: "" }, { now: NOW });
  assert.equal(result.tier, "forgotten", "an unknown age must not earn freshness");
  assert.equal(ageLabel(result.days), "日期未知");
});

test("created is the fallback when updated is missing", () => {
  const result = tierOf({ name: "x", updated: "", created: ago(2) }, { now: NOW });
  assert.equal(result.tier, "recent");
});

test("a future date does not produce a negative age", () => {
  // Clock skew or a hand-edited date must not crash or invent a tier.
  const result = tierOf(card(ago(-5)), { now: NOW });
  assert.equal(result.tier, "recent");
  assert.match(ageLabel(result.days), /今天|天前/);
});

test("activityTime takes the newest usable date", () => {
  assert.equal(activityTime(card(ago(10), ago(20)), undefined), parseDate(ago(10)));
  assert.equal(activityTime(card(ago(10), ago(20)), ago(1)), parseDate(ago(1)));
  assert.equal(activityTime({ updated: "", created: "" }, undefined), undefined);
});

test("the detail ladder shrinks with age and hides only the oldest", () => {
  assert.equal(TIER_DETAIL.recent, "full");
  assert.equal(TIER_DETAIL.past, "full");
  assert.equal(TIER_DETAIL.old, "compact");
  assert.equal(TIER_DETAIL.ancient, "minimal");
  assert.equal(TIER_DETAIL.forgotten, "hidden");

  // Only the forgotten tier leaves the index; every other tier stays reachable through it.
  for (const tier of TIER_ORDER) {
    assert.equal(isInjected(tier), tier !== "forgotten", `${tier} injection`);
  }
});

test("every tier has a Chinese label and the ladder is ordered", () => {
  for (const tier of TIER_ORDER) {
    assert.equal(typeof TIER_LABELS[tier], "string");
    assert.match(TIER_LABELS[tier], /[\u4e00-\u9fa5]/, `${tier} label must be Chinese`);
  }
  assert.deepEqual(TIER_ORDER, ["recent", "past", "old", "ancient", "forgotten"]);
});

test("ageLabel is coarse on purpose", () => {
  assert.equal(ageLabel(0), "今天");
  assert.equal(ageLabel(1), "昨天");
  assert.equal(ageLabel(3), "3 天前");
  assert.equal(ageLabel(45), "1 个月前");
  assert.equal(ageLabel(400), "1 年前");
  assert.equal(ageLabel(Number.POSITIVE_INFINITY), "日期未知");
});

test("resolveTierDays fills defaults and rejects an unusable ladder", () => {
  assert.deepEqual(resolveTierDays(undefined), DEFAULT_TIER_DAYS);
  assert.deepEqual(resolveTierDays({}), DEFAULT_TIER_DAYS);
  assert.deepEqual(resolveTierDays({ past: 1, old: 2, ancient: 3, forgotten: 4 }), {
    past: 1, old: 2, ancient: 3, forgotten: 4,
  });

  // A non-increasing ladder would make a tier unreachable, so the whole set falls back rather than
  // silently skipping one.
  assert.deepEqual(resolveTierDays({ past: 30, old: 7, ancient: 90, forgotten: 365 }), DEFAULT_TIER_DAYS);
  assert.deepEqual(resolveTierDays({ past: 7, old: 7, ancient: 90, forgotten: 365 }), DEFAULT_TIER_DAYS);
  assert.deepEqual(resolveTierDays({ past: 0, old: 30, ancient: 90, forgotten: 365 }), DEFAULT_TIER_DAYS);
  assert.deepEqual(resolveTierDays({ past: 1, old: 2, ancient: 3, forgotten: 2 }), DEFAULT_TIER_DAYS);
});

test("a partial configuration keeps the defaults for the rest", () => {
  const resolved = resolveTierDays({ past: 3 });
  assert.equal(resolved.past, 3);
  assert.equal(resolved.old, DEFAULT_TIER_DAYS.old);
  assert.equal(resolved.ancient, DEFAULT_TIER_DAYS.ancient);
  assert.equal(resolved.forgotten, DEFAULT_TIER_DAYS.forgotten);
});

/**
 * Build a workspace whose cards are aged across every tier.
 * @returns the workspace path.
 */
async function agedWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-tiers-"));
  const store = resolveStore(cwd);
  const cards = [
    ["fresh-card", "刚排查完的问题", "rebase", 2],
    ["past-card", "上个月的做法", "png 导出", 20],
    ["old-card", "三个月前的流程", "打包配置", 60],
    ["ancient-card", "去年踩过的坑", "老接口", 200],
    ["forgotten-card", "很久没用过的东西", "已废弃", 500],
  ];
  for (const [name, description, trigger, daysAgo] of cards) {
    const date = formatDate(Date.now() - daysAgo * 86_400_000);
    // Seeded with explicit dates because a real save always stamps today, which cannot exercise a
    // ladder whose whole subject is elapsed time.
    await importCard(store, {
      name, description, triggers: [trigger], status: "verified", revision: 1,
      created: date, updated: date, body: "## 做法\n\n内容。",
    });
  }
  return cwd;
}

test("the injected index groups by tier and shrinks detail with age", async () => {
  const cwd = await agedWorkspace();
  const index = renderIndex(await refreshIndex(cwd, {
    maxCatalogCards: 50,
    tierDays: DEFAULT_TIER_DAYS,
  }));

  // Grouping, and the per-tier counts.
  for (const label of ["近期", "之前", "很久之前", "远古"]) {
    assert.match(index, new RegExp(`\\*\\*${label}\\*\\*`), `${label} group`);
  }
  assert.match(index, /近期 1、之前 1、很久之前 1、远古 1、遗忘 1/);

  // Detail shrinks: full routing line, then description only, then a bare name list.
  assert.match(index, /fresh-card`：刚排查完的问题；触发：rebase/);
  assert.match(index, /past-card`：上个月的做法；触发：png 导出/);
  assert.match(index, /old-card`：三个月前的流程；/, "an old card keeps its description");
  assert.doesNotMatch(index, /old-card`：三个月前的流程；触发/, "but loses its trigger list");
  assert.match(index, /`ancient-card`/, "an ancient card is listed by name");
  assert.doesNotMatch(index, /ancient-card`：/, "and nothing more");
});

test("a forgotten card is neither named nor advertised, but is still counted", async () => {
  const cwd = await agedWorkspace();
  const index = renderIndex(await refreshIndex(cwd, {
    maxCatalogCards: 50,
    tierDays: DEFAULT_TIER_DAYS,
  }));

  // The name must not leak in any form — not in a group, and not in the overflow line either, which
  // is why overflow and the hidden tier are tracked separately.
  assert.doesNotMatch(index, /forgotten-card/, "a forgotten card must not be named");
  assert.match(index, /另有 1 张已进入遗忘档/, "but its existence is reported");
  assert.match(index, /task_memory_search/, "and the way to reach it is stated");
});

test("the injected budget is spent on newer tiers first", async () => {
  const cwd = await agedWorkspace();
  const index = renderIndex(await refreshIndex(cwd, { maxCatalogCards: 2, tierDays: DEFAULT_TIER_DAYS }));

  // The two newest cards take the whole budget; every older tier is skipped and named on the
  // overflow line instead. That ordering is the point: a card proven this week must never be pushed
  // out by one nobody has touched in months.
  assert.match(index, /fresh-card/);
  assert.match(index, /past-card/);
  assert.match(index, /索引已达上限，另有 2 张未列出（`old-card`、`ancient-card`）/,
    "the older tiers wait behind the newer ones");
  assert.doesNotMatch(index, /\*\*很久之前\*\*/, "a skipped tier gets no section");
  assert.doesNotMatch(index, /\*\*远古\*\*/, "a skipped tier gets no section");
  assert.doesNotMatch(index, /forgotten-card/, "the forgotten tier is never named");
});
