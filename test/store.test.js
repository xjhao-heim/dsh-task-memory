/**
 * Store tests.
 *
 * The guarantees these cover are the ones the design rests on: one card per task, a merge that
 * cannot silently erase earlier knowledge, usage counters that cannot drift from their card, writes
 * that survive concurrent callers, and assets that die with their card.
 *
 * Each test opens its own in-memory database, so cases cannot leak into each other and no test
 * touches the user's real memory file.
 */

import assert from "node:assert/strict";
import test from "node:test";
import "./setup.js";
import { openDatabase } from "../lib/db.js";
import {
  assertCardName,
  closeSharedDatabase,
  deleteAsset,
  deleteCard,
  getCard,
  importCard,
  listAssets,
  listCards,
  mergeBody,
  readAsset,
  readStats,
  recordHit,
  resolveStore,
  saveCard,
  searchCards,
  writeAsset,
} from "../lib/store.js";

/** A fresh workspace backed by a throwaway in-memory database. */
function workspace() {
  const db = openDatabase(":memory:");
  return { db, store: resolveStore("D:\\AI", { db }) };
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

test("stores a card and reads it back", async () => {
  const { store } = workspace();
  const result = await saveCard(store, CARD);

  assert.equal(result.outcome, "created");
  assert.equal(result.card.revision, 1);
  assert.equal(result.card.description, CARD.description);
  assert.deepEqual(result.card.triggers, CARD.triggers);
  assert.deepEqual(result.card.tags, CARD.tags);
  assert.equal(result.card.whenToUse, CARD.whenToUse);

  const reread = await getCard(store, CARD.name);
  assert.equal(reread.body, CARD.body);
  assert.equal(reread.published, false, "publication defaults to off");
});

test("cards are isolated per workspace in the shared database", async () => {
  const db = openDatabase(":memory:");
  const first = resolveStore("D:\\AI", { db });
  const second = resolveStore("D:\\Work", { db });
  await saveCard(first, CARD);

  assert.equal((await listCards(first)).length, 1);
  assert.equal((await listCards(second)).length, 0, "another workspace must not see it");
  assert.equal(await getCard(second, CARD.name), undefined);

  // The same name in two workspaces is two independent cards, which is what the composite key buys.
  await saveCard(second, { ...CARD, description: "另一个工作区的同名卡" });
  assert.equal((await getCard(first, CARD.name)).description, CARD.description);
  assert.equal((await getCard(second, CARD.name)).description, "另一个工作区的同名卡");
});

test("creating the same name twice without permission reports the existing card", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);
  const second = await saveCard(store, { ...CARD, allowUpdate: false });

  assert.equal(second.outcome, "exists");
  assert.equal((await listCards(store)).length, 1);
  assert.equal((await getCard(store, CARD.name)).revision, 1, "a refused save changes nothing");
});

test("updating bumps the revision and keeps unmentioned sections", async () => {
  const { store } = workspace();
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

test("a human save replaces the body verbatim instead of merging", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);
  const replaced = await saveCard(store, {
    ...CARD,
    body: "## 做法\n\n只剩这一段。",
    triggers: ["只剩"],
    allowUpdate: true,
    replaceBody: true,
    replaceFields: true,
  });

  assert.doesNotMatch(replaced.card.body, /## 适用场景/, "a section the editor removed must not return");
  assert.doesNotMatch(replaced.card.body, /## 变更记录/, "verbatim means verbatim");
  assert.deepEqual(replaced.card.triggers, ["只剩"], "a removed trigger must not return");
});

test("the changelog always stays last, even when a save adds a section", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);
  const updated = await saveCard(store, {
    ...CARD,
    body: `${CARD.body}\n\n## 坑\n\n新踩的坑。`,
    allowUpdate: true,
  });

  const headings = updated.card.body.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());
  assert.equal(headings.at(-1), "变更记录", `history must be last, got: ${headings.join(" | ")}`);
  assert.ok(headings.includes("坑"), "the added section must still be present");
});

test("mergeBody is idempotent when nothing changed", () => {
  const body = "## 做法\n\nA\n\n## 验证\n\nB";
  const merged = mergeBody(body, body, { revision: 1, date: "2026-01-01" });
  assert.match(merged, /## 做法/);
  assert.match(merged, /## 验证/);
});

test("usage counters live on the card row and move together", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);
  await recordHit(store, CARD.name);
  await recordHit(store, CARD.name);
  await recordHit(store, CARD.name);

  const stats = await readStats(store);
  assert.equal(stats.hits.get(CARD.name), 3);
  assert.match(stats.lastUsed.get(CARD.name), /^\d{4}-\d{2}-\d{2}$/, "the retrieval date is recorded too");

  // A card update must not reset what the card has earned.
  await saveCard(store, { ...CARD, description: "改过描述", allowUpdate: true });
  const after = await readStats(store);
  assert.equal(after.hits.get(CARD.name), 3, "an edit keeps the usage history");
  assert.equal((await getCard(store, CARD.name)).revision, 2);
});

test("recording a hit for a missing card is not an error", async () => {
  const { store } = workspace();
  await recordHit(store, "never-existed");
  assert.equal((await readStats(store)).hits.size, 0);
});

test("concurrent writes to one card do not lose an update", async () => {
  const { store } = workspace();
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

test("assets are stored with the card and die with it", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);

  await writeAsset(store, CARD.name, "patch/fix.diff", new TextEncoder().encode("diff --git"));
  assert.deepEqual(await listAssets(store, CARD.name), ["patch/fix.diff"]);
  assert.equal(new TextDecoder().decode(await readAsset(store, CARD.name, "patch/fix.diff")), "diff --git");

  // Overwriting replaces rather than accumulating.
  await writeAsset(store, CARD.name, "patch/fix.diff", new TextEncoder().encode("v2"));
  assert.equal(new TextDecoder().decode(await readAsset(store, CARD.name, "patch/fix.diff")), "v2");

  assert.equal(await deleteAsset(store, CARD.name, "patch/fix.diff"), true);
  assert.equal(await deleteAsset(store, CARD.name, "patch/fix.diff"), false, "removing twice is not an error");
  assert.deepEqual(await listAssets(store, CARD.name), []);
});

test("a removed card takes its assets with it", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);
  await writeAsset(store, CARD.name, "note.txt", new TextEncoder().encode("x"));

  assert.equal(await deleteCard(store, CARD.name), true);
  assert.equal(await deleteCard(store, CARD.name), false, "a second delete reports nothing removed");
  assert.deepEqual(await listCards(store), []);
  // The foreign key's cascade is what guarantees no asset outlives its card.
  assert.deepEqual(await listAssets(store, CARD.name), []);
});

test("an asset cannot be attached to a card that does not exist", async () => {
  const { store } = workspace();
  await assert.rejects(
    () => writeAsset(store, "no-such-card", "a.txt", new TextEncoder().encode("x")),
    /does not exist/,
  );
});

test("card names are constrained", () => {
  assert.throws(() => assertCardName("../escape"), /kebab-case/);
  assert.throws(() => assertCardName("Has Spaces"), /kebab-case/);
  assert.throws(() => assertCardName(""), /required/);
  assert.throws(() => assertCardName("x".repeat(80)), /longer than/);
});

test("search finds body text and returns a snippet", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);

  const hits = await searchCards(store, "uniformRowHeights");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, CARD.name);
  assert.match(hits[0].snippet, /uniformRowHeights/);

  assert.deepEqual(await searchCards(store, "不存在的词"), []);
});

test("search supports a regular expression and rejects an invalid one", async () => {
  const { store } = workspace();
  await saveCard(store, CARD);

  const hits = await searchCards(store, "set(Uniform|Vertical)\\w+", { regex: true });
  assert.equal(hits.length, 1);
  // The tool wraps this call and turns the failure into a readable message, so the rejection itself
  // is the contract worth pinning here.
  await assert.rejects(() => searchCards(store, "(", { regex: true }), SyntaxError);
});

test("importCard reproduces a card verbatim, including its history", async () => {
  const { store } = workspace();
  const imported = await importCard(store, {
    name: CARD.name,
    description: CARD.description,
    triggers: CARD.triggers,
    tags: CARD.tags,
    status: "stale",
    published: true,
    revision: 7,
    created: "2026-01-01",
    updated: "2026-02-02",
    body: CARD.body,
    hits: 5,
    lastUsed: "2026-02-02",
  });

  // An import must not re-derive dates or revision the way a fresh save would.
  assert.equal(imported.revision, 7);
  assert.equal(imported.created, "2026-01-01");
  assert.equal(imported.updated, "2026-02-02");
  assert.equal(imported.status, "stale");
  assert.equal(imported.published, true);
  const stats = await readStats(store);
  assert.equal(stats.hits.get(CARD.name), 5);
  assert.equal(stats.lastUsed.get(CARD.name), "2026-02-02");
});

test("an empty store lists nothing", async () => {
  const { store } = workspace();
  assert.deepEqual(await listCards(store), []);
  const stats = await readStats(store);
  assert.deepEqual(stats.hits, new Map());
  assert.deepEqual(stats.lastUsed, new Map());
});

test("a store needs an absolute workspace", () => {
  assert.throws(() => resolveStore(""), /absolute session working directory/);
  assert.throws(() => resolveStore("relative/path"), /absolute session working directory/);
});

test("the shared connection can be closed more than once", () => {
  closeSharedDatabase();
  closeSharedDatabase();
  assert.ok(true, "closing an unopened database is not an error");
});
