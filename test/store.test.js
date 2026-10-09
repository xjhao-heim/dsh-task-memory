/**
 * Store tests.
 *
 * The guarantees these cover are the ones the design rests on: one card per task, a merge that
 * cannot silently erase earlier knowledge, an index derived from the files rather than stored
 * beside them, and writes that survive concurrent callers.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCardName,
  deleteCard,
  getCard,
  listAssets,
  listCards,
  mergeBody,
  readStats,
  recordHit,
  resolveStore,
  saveCard,
  searchCards,
} from "../lib/store.js";

/**
 * Create an isolated workspace for one test.
 * @returns the workspace path and its resolved store.
 */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  return { cwd, store: resolveStore(cwd) };
}

const CARD = {
  name: "qt-tableview-flicker",
  description: "QTableView 滚动闪烁",
  whenToUse: "表格滚动时闪烁或卡顿",
  triggers: ["表格闪烁", "setUniformRowHeights"],
  tags: ["qt"],
  body: "## 适用场景\n\n大表格滚动。\n\n## 做法\n\n开启 uniformRowHeights。",
  allowUpdate: true,
};

test("stores a card under .dsh/task-memory/notes and reads it back", async () => {
  const { store } = await workspace();
  const result = await saveCard(store, CARD);

  assert.equal(result.outcome, "created");
  assert.equal(result.card.revision, 1);
  assert.equal(result.card.description, CARD.description);
  assert.deepEqual(result.card.triggers, CARD.triggers);
  assert.match(result.card.path, /\.dsh[\\/]task-memory[\\/]notes[\\/]qt-tableview-flicker[\\/]SKILL\.md$/);

  const reread = await getCard(store, CARD.name);
  assert.equal(reread.body, CARD.body);
});

test("creating the same name twice without permission reports the existing card", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  const second = await saveCard(store, { ...CARD, allowUpdate: false });

  assert.equal(second.outcome, "exists");
  const cards = await listCards(store);
  assert.equal(cards.length, 1);
});

test("updating bumps the revision and keeps unmentioned sections", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  const updated = await saveCard(store, {
    ...CARD,
    body: "## 做法\n\n开启 uniformRowHeights，并设置 setVerticalScrollMode。",
    triggers: ["滚动卡顿"],
    allowUpdate: true,
  });

  assert.equal(updated.outcome, "updated");
  assert.equal(updated.card.revision, 2);
  assert.match(updated.card.body, /## 适用场景/, "an unmentioned section must survive the merge");
  assert.match(updated.card.body, /setVerticalScrollMode/, "the rewritten section must be replaced");
  assert.doesNotMatch(updated.card.body, /开启 uniformRowHeights。/);
  assert.deepEqual(updated.card.triggers, ["表格闪烁", "setUniformRowHeights", "滚动卡顿"]);
  assert.match(updated.card.body, /## 变更记录/);
});

test("a new section is appended and the changelog records it", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  const updated = await saveCard(store, {
    ...CARD,
    body: `${CARD.body}\n\n## 坑\n\n不要同时开启 wordWrap。`,
    allowUpdate: true,
  });

  assert.match(updated.card.body, /## 坑/);
  assert.match(updated.card.body, /更新 坑/);
});

test("the changelog always stays last, even when a save adds a section", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  const updated = await saveCard(store, {
    ...CARD,
    body: `${CARD.body}\n\n## 坑\n\n新踩的坑。`,
    allowUpdate: true,
  });

  const headings = updated.card.body
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
  assert.equal(headings.at(-1), "变更记录", `history must be last, got: ${headings.join(" | ")}`);
  assert.ok(headings.includes("坑"), "the added section must still be present");
});

test("a later save keeps the changelog last after several merges", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  await saveCard(store, { ...CARD, body: `${CARD.body}\n\n## 坑\n\n坑一。`, allowUpdate: true });
  const third = await saveCard(store, { ...CARD, body: `${CARD.body}\n\n## 验证\n\n验证一。`, allowUpdate: true });

  const headings = third.card.body.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());
  assert.equal(headings.at(-1), "变更记录");
  assert.equal(third.card.revision, 3);
  // Both earlier additions must survive, and both revisions must be recorded.
  assert.ok(headings.includes("坑"), "the earlier section must survive");
  assert.ok(headings.includes("验证"), "the new section must be added");
  assert.match(third.card.body, /r2/);
  assert.match(third.card.body, /r3/);
});

test("mergeBody is idempotent when nothing changed", () => {
  const body = "## 做法\n\nA\n\n## 验证\n\nB";
  const merged = mergeBody(body, body, { revision: 1, date: "2026-01-01" });
  assert.match(merged, /## 做法/);
  assert.match(merged, /## 验证/);
});

test("load counters live outside the card, so reading never rewrites authored content", async () => {
  const { store } = await workspace();
  const created = await saveCard(store, CARD);
  const before = await readFile(created.card.path, "utf8");

  await recordHit(store, CARD.name);
  await recordHit(store, CARD.name);
  await recordHit(store, CARD.name);

  assert.equal(await readFile(created.card.path, "utf8"), before, "card bytes must be untouched");
  assert.equal((await readStats(store)).get(CARD.name), 3);
});

test("concurrent writes to one card do not lose an update", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);

  await Promise.all([
    saveCard(store, { ...CARD, body: "## 做法\n\n第一次更新", allowUpdate: true }),
    saveCard(store, { ...CARD, body: "## 验证\n\n第二次更新", allowUpdate: true }),
    saveCard(store, { ...CARD, body: "## 坑\n\n第三次更新", allowUpdate: true }),
  ]);

  const card = await getCard(store, CARD.name);
  assert.equal(card.revision, 4, "every serialized update must land");
  for (const heading of ["适用场景", "做法", "验证", "坑"]) {
    assert.match(card.body, new RegExp(`## ${heading}`), `${heading} must survive`);
  }
});

test("a malformed card is reported instead of hidden", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  const broken = join(store.notes, "broken-card");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "## 没有 frontmatter", "utf8");

  const cards = await listCards(store);
  const found = cards.find((card) => card.name === "broken-card");
  assert.ok(found, "the unreadable card must still be listed");
  assert.match(found.problem, /frontmatter/);
});

test("card names are constrained and cannot escape the store", async () => {
  assert.throws(() => assertCardName("../escape"), /kebab-case/);
  assert.throws(() => assertCardName("Has Spaces"), /kebab-case/);
  assert.throws(() => assertCardName(""), /required/);

  const { store } = await workspace();
  assert.throws(() => store.cardPath("../../etc"), /kebab-case/);
});

test("asset files are listed relative to the card", async () => {
  const { store } = await workspace();
  const created = await saveCard(store, CARD);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(created.card.directory, "assets", "patch"), { recursive: true });
  await writeFile(join(created.card.directory, "assets", "patch", "fix.diff"), "diff", "utf8");

  assert.deepEqual(await listAssets(created.card), ["patch/fix.diff"]);
});

test("search finds body text and returns a snippet", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);

  const hits = await searchCards(store, "uniformRowHeights");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, CARD.name);
  assert.match(hits[0].snippet, /uniformRowHeights/);

  assert.deepEqual(await searchCards(store, "不存在的词"), []);
});

test("search supports a regular expression and rejects an invalid one", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);

  const hits = await searchCards(store, "set(Uniform|Vertical)\\w+", { regex: true });
  assert.equal(hits.length, 1);
  // The tool wraps this call and turns the failure into a readable message, so the rejection itself
  // is the contract worth pinning here.
  await assert.rejects(() => searchCards(store, "(", { regex: true }), SyntaxError);
});

test("deleteCard removes the whole card directory", async () => {
  const { store } = await workspace();
  await saveCard(store, CARD);
  assert.equal(await deleteCard(store, CARD.name), true);
  assert.equal(await deleteCard(store, CARD.name), false);
  assert.deepEqual(await listCards(store), []);
  assert.deepEqual((await readdir(store.notes)).filter((entry) => entry === CARD.name), []);
});

test("an empty store lists nothing without creating directories", async () => {
  const { store } = await workspace();
  assert.deepEqual(await listCards(store), []);
  assert.deepEqual(await readStats(store), new Map());
});
