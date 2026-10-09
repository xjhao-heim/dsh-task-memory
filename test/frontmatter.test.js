/**
 * Frontmatter codec tests.
 *
 * The codec is the one place where a hand edit and a programmatic write meet, so the round-trip
 * property and the awkward-scalar cases are what actually matter here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listField, parseCard, serializeCard } from "../lib/frontmatter.js";

test("parses scalars, inline lists, and block lists", () => {
  const text = [
    "---",
    "name: qt-tableview-flicker",
    "description: \"QTableView 闪烁: 已修\"",
    "whenToUse: 表格滚动闪烁时",
    "triggers: [表格闪烁, \"setUniformRowHeights\"]",
    "tags:",
    "  - qt",
    "  - performance",
    "revision: 3",
    "---",
    "",
    "## 适用场景",
    "",
    "内容",
    "",
  ].join("\n");

  const { fields, body } = parseCard(text);
  assert.equal(fields.name, "qt-tableview-flicker");
  assert.equal(fields.description, "QTableView 闪烁: 已修");
  assert.deepEqual(fields.triggers, ["表格闪烁", "setUniformRowHeights"]);
  assert.deepEqual(fields.tags, ["qt", "performance"]);
  assert.equal(fields.revision, 3);
  assert.equal(body, "## 适用场景\n\n内容");
});

test("round-trips fields that would otherwise be misread by YAML", () => {
  const awkward = [
    "含冒号: 的值",
    "# 井号开头",
    "- 破折号开头",
    "true",
    "123",
    "  前后有空格  ",
    '"引号"包裹',
    "换行\n在里面",
    "尾部斜杠\\",
  ];
  const fields = { name: "sample-card", description: awkward[0], triggers: awkward, tags: [], revision: 1, hits: 0 };
  const { fields: parsed } = parseCard(serializeCard(fields, "正文"));

  assert.equal(parsed.description, awkward[0]);
  assert.deepEqual(parsed.triggers, awkward);
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.revision, 1);
});

test("rejects a file without frontmatter", () => {
  assert.throws(() => parseCard("## 只有正文"), /no YAML frontmatter/);
});

test("rejects an unterminated frontmatter block", () => {
  assert.throws(() => parseCard("---\nname: x\n\n## body"), /not closed/);
});

test("rejects an unterminated flow list", () => {
  assert.throws(() => parseCard("---\nname: x\ntriggers: [a, b\n---\n"), /unterminated flow list/);
});

test("listField tolerates a hand-written single string", () => {
  assert.deepEqual(listField({ triggers: "只有一个" }, "triggers"), ["只有一个"]);
  assert.deepEqual(listField({}, "triggers"), []);
});
