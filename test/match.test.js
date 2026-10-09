/**
 * Deduplication tests.
 *
 * The rule this protects: one task, one card. The failure it must catch is the realistic one — the
 * same problem saved twice under two different names, in different words, in two languages.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classify, normalize, trigrams, THRESHOLDS } from "../lib/match.js";

/**
 * Build a card-shaped candidate.
 * @param overrides - fields to override.
 * @returns a candidate card.
 */
function card(overrides) {
  return {
    name: "base",
    description: "",
    whenToUse: undefined,
    triggers: [],
    tags: [],
    ...overrides,
  };
}

test("normalize collapses punctuation and case", () => {
  assert.equal(normalize("QTableView 滚动/闪烁!!"), "qtableview 滚动 闪烁");
  assert.equal(normalize(""), "");
});

test("trigrams of an empty string are empty", () => {
  assert.equal(trigrams("").size, 0);
  assert.equal(trigrams("   ").size, 0);
  assert.ok(trigrams("表格闪烁").size > 0);
});

test("the same task described in different words is caught", () => {
  const existing = [card({
    name: "qt-tableview-flicker",
    description: "QTableView 滚动闪烁",
    triggers: ["表格闪烁", "setUniformRowHeights"],
  })];
  const { duplicate } = classify(existing, card({
    name: "table-scroll-shimmer",
    description: "表格滚动时闪烁",
    triggers: ["表格闪烁"],
  }));

  assert.ok(duplicate, "a restatement must be refused");
  assert.equal(duplicate.card.name, "qt-tableview-flicker");
  assert.ok(duplicate.reasons.length > 0, "the match must be explainable");
});

test("a shared trigger word alone is enough to flag a duplicate", () => {
  const existing = [card({
    name: "one",
    description: "完全不同的描述",
    triggers: ["界面尺寸标注"],
  })];
  const { duplicate } = classify(existing, card({
    name: "two",
    description: "另一段无关文字",
    triggers: ["界面尺寸标注"],
  }));
  assert.ok(duplicate, "an exact trigger match is strong evidence");
});

test("an unrelated task is not blocked", () => {
  const existing = [card({
    name: "qt-tableview-flicker",
    description: "QTableView 滚动闪烁",
    triggers: ["表格闪烁"],
    tags: ["qt"],
  })];
  const { duplicate, related } = classify(existing, card({
    name: "git-rebase-conflict",
    description: "rebase 冲突解决流程",
    triggers: ["rebase", "冲突"],
    tags: ["git"],
  }));

  assert.equal(duplicate, undefined);
  assert.deepEqual(related, []);
});

test("identical names never block themselves, so an update is allowed", () => {
  const existing = [card({
    name: "same-card",
    description: "同一个任务",
    triggers: ["x"],
  })];
  const { duplicate, related } = classify(existing, card({
    name: "same-card",
    description: "同一个任务",
    triggers: ["x"],
  }));
  assert.equal(duplicate, undefined, "a card must not be its own duplicate");
  assert.deepEqual(related, [], "a card must not be reported as related to itself either");
});

test("updating one card does not list that card among the related ones", () => {
  const existing = [
    card({ name: "target-card", description: "目标任务", triggers: ["目标"] }),
    card({ name: "other-card", description: "无关任务", triggers: ["无关"] }),
  ];
  const { related } = classify(existing, card({
    name: "target-card",
    description: "目标任务",
    triggers: ["目标", "新触发词"],
  }));
  assert.deepEqual(related.map((entry) => entry.card.name), []);
});

test("a related-but-different task is reported without blocking", () => {
  const existing = [card({
    name: "westock-ui-measure",
    description: "微投证券界面像素测量流程",
    triggers: ["界面测量", "像素间距"],
    tags: ["qt", "ui"],
  })];
  const { duplicate, related } = classify(existing, card({
    name: "westock-dialog-style",
    description: "微投证券弹窗样式适配",
    triggers: ["弹窗样式"],
    tags: ["qt"],
  }));

  assert.equal(duplicate, undefined, "a related card must not block a genuinely new one");
  assert.ok(related.length > 0, "but it should be surfaced");
});

test("a generic shared name fragment alone does not make unrelated tasks related", () => {
  // "-card" is shared by both names but carries no task meaning; only the distinctive words count.
  const { related, duplicate } = classify(
    [card({ name: "other-card", description: "无关任务", triggers: ["无关"] })],
    card({ name: "target-card", description: "目标任务", triggers: ["目标"] }),
  );
  assert.equal(duplicate, undefined);
  assert.deepEqual(related, [], "a shared generic suffix must not create a false relation");
});

test("the same task in Chinese and English still matches on shared trigger words", () => {
  const existing = [card({
    name: "qt-tableview-flicker",
    description: "QTableView 滚动闪烁",
    triggers: ["setUniformRowHeights", "表格闪烁"],
  })];
  const { duplicate } = classify(existing, card({
    name: "qtableview-scroll-perf",
    description: "table view scrolling performance",
    triggers: ["setUniformRowHeights"],
  }));

  assert.ok(duplicate, "a shared API name must be enough across languages");
  assert.match(duplicate.reasons.join(" "), /setUniformRowHeights/);
});

test("an empty store never produces a duplicate", () => {
  const { duplicate, related } = classify([], card({ name: "anything", description: "anything" }));
  assert.equal(duplicate, undefined);
  assert.deepEqual(related, []);
});

test("the documented threshold is the one applied", () => {
  assert.equal(THRESHOLDS.duplicate, 0.55);
  const borderline = [
    card({ name: "alpha-beta", description: "abcdefghij klmnopqrst" }),
  ];
  const { ranked } = classify(borderline, card({ name: "zzz-yyy", description: "0123456789 987654321" }));
  for (const entry of ranked) assert.ok(entry.score < THRESHOLDS.duplicate);
});
