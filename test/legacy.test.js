/**
 * Legacy import tests.
 *
 * The import moves knowledge out of files a user still has and into the database, so the cases that
 * matter are the ones where a migration goes wrong quietly: a card that fails to parse, a second run
 * that duplicates work, and a delete that happens before anyone has checked the result.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Isolates the database before anything opens it.
import "./setup.js";
import { openDatabase } from "../lib/db.js";
import { importLegacy, legacyPaths, previewLegacy, removeLegacy, scanLegacy } from "../lib/legacy.js";
import { getCard, listAssets, listCards, readAsset, resolveStore, saveCard } from "../lib/store.js";

/**
 * Build a workspace with a file-backed memory, the way the previous layout stored one.
 *
 * @param cards - `{ name, frontmatter?, body?, assets? }` entries.
 * @returns the workspace path and its store.
 */
async function legacyWorkspace(cards) {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-legacy-"));
  const paths = legacyPaths(cwd);
  for (const card of cards) {
    const directory = join(paths.notes, card.name);
    await mkdir(directory, { recursive: true });
    const frontmatter = card.frontmatter ?? [
      "---",
      `name: ${card.name}`,
      `description: ${card.description ?? card.name}`,
      "triggers:",
      "  - 旧触发词",
      "status: verified",
      "revision: 3",
      "created: 2026-01-01",
      "updated: 2026-02-02",
      "---",
      "",
    ].join("\n");
    await writeFile(join(directory, "SKILL.md"), `${frontmatter}${card.body ?? "## 做法\n\n旧内容。"}\n`, "utf8");
    for (const asset of card.assets ?? []) {
      const target = join(directory, "assets", asset.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, asset.text, "utf8");
    }
  }
  if (cards.length > 0) {
    await writeFile(paths.stats, JSON.stringify({
      version: 2,
      hits: Object.fromEntries(cards.map((card) => [card.name, card.hits ?? 0])),
      lastUsed: Object.fromEntries(cards.filter((card) => card.lastUsed).map((card) => [card.name, card.lastUsed])),
    }), "utf8");
  }
  const db = openDatabase(":memory:");
  return { cwd, store: resolveStore(cwd, { db }), paths };
}

test("a workspace without legacy files reports nothing to import", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-empty-"));
  const scan = await scanLegacy(cwd);
  assert.equal(scan.found, false);
  assert.deepEqual(scan.cards, []);
});

test("the scan reads cards, usage counters, and assets without writing anything", async () => {
  const { cwd, store } = await legacyWorkspace([
    { name: "old-card", description: "旧卡片", hits: 4, lastUsed: "2026-02-02", assets: [{ path: "patch/fix.diff", text: "diff" }] },
  ]);

  const scan = await scanLegacy(cwd);
  assert.equal(scan.found, true);
  assert.equal(scan.cards.length, 1);
  assert.equal(scan.cards[0].description, "旧卡片");
  assert.deepEqual(scan.cards[0].triggers, ["旧触发词"]);
  assert.equal(scan.cards[0].revision, 3, "the stored revision is carried, not re-derived");
  assert.equal(scan.cards[0].hits, 4);
  assert.equal(scan.cards[0].lastUsed, "2026-02-02");
  assert.deepEqual(scan.cards[0].assets.map((asset) => asset.path), ["patch/fix.diff"]);

  // A scan is a read: the database is untouched.
  assert.deepEqual(await listCards(store), []);
});

test("importing writes the card, its history, and its assets", async () => {
  const { cwd, store } = await legacyWorkspace([
    { name: "old-card", description: "旧卡片", hits: 4, lastUsed: "2026-02-02", assets: [{ path: "patch/fix.diff", text: "diff --git" }] },
  ]);
  const result = await importLegacy(store, await scanLegacy(cwd));

  assert.deepEqual(result.imported.map((row) => row.name), ["old-card"]);
  assert.equal(result.imported[0].assets, 1);
  const card = await getCard(store, "old-card");
  assert.equal(card.description, "旧卡片");
  assert.equal(card.revision, 3, "an import must not reset the revision");
  assert.equal(card.created, "2026-01-01");
  assert.equal(card.updated, "2026-02-02", "nor the dates");
  assert.deepEqual(await listAssets(store, "old-card"), ["patch/fix.diff"]);
  assert.equal(new TextDecoder().decode(await readAsset(store, "old-card", "patch/fix.diff")), "diff --git");
});

test("a second import skips what is already there instead of duplicating it", async () => {
  const { cwd, store } = await legacyWorkspace([{ name: "old-card", description: "旧卡片" }]);
  const scan = await scanLegacy(cwd);
  await importLegacy(store, scan);
  const again = await importLegacy(store, await scanLegacy(cwd));

  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.skipped.map((row) => row.name), ["old-card"]);
  assert.equal((await listCards(store)).length, 1, "one task keeps one card");
});

test("overwrite lets the file version replace a stored card", async () => {
  const { cwd, store } = await legacyWorkspace([{ name: "old-card", description: "文件里的版本" }]);
  await saveCard(store, { name: "old-card", description: "数据库里的版本", body: "## 做法\n\n新。", allowUpdate: true });

  const result = await importLegacy(store, await scanLegacy(cwd), { overwrite: true });
  assert.equal(result.imported[0].overwritten, true);
  assert.equal((await getCard(store, "old-card")).description, "文件里的版本");
});

test("a card whose frontmatter is unreadable is reported, not dropped silently", async () => {
  const { cwd, store } = await legacyWorkspace([{ name: "good-card", description: "好卡片" }]);
  // A card file with no frontmatter at all: the reader must refuse it by name.
  const broken = join(legacyPaths(cwd).notes, "broken-card");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "## 没有 frontmatter", "utf8");

  const scan = await scanLegacy(cwd);
  assert.equal(scan.cards.length, 1, "the readable card still imports");
  assert.equal(scan.unreadable.length, 1);
  assert.match(scan.unreadable[0].reason, /frontmatter/);

  const preview = await previewLegacy(store, scan);
  assert.equal(preview.totals.unreadable, 1);

  const result = await importLegacy(store, scan);
  assert.deepEqual(result.imported.map((row) => row.name), ["good-card"], "one bad file must not stop the rest");
});

test("the preview distinguishes new cards from conflicts before anything is written", async () => {
  const { cwd, store } = await legacyWorkspace([
    { name: "brand-new", description: "新的" },
    { name: "already-there", description: "已存在" },
  ]);
  await saveCard(store, { name: "already-there", description: "数据库里", body: "## x\n\ny", allowUpdate: true });

  const preview = await previewLegacy(store, await scanLegacy(cwd));
  assert.equal(preview.totals.cards, 2);
  assert.equal(preview.totals.create, 1);
  assert.equal(preview.totals.conflict, 1);
  assert.deepEqual(
    preview.cards.map((row) => [row.name, row.action]).sort(),
    [["already-there", "conflict"], ["brand-new", "create"]],
  );
  assert.equal((await listCards(store)).length, 1, "a preview writes nothing");
});

test("removing the source deletes only the two known artifacts", async () => {
  const { cwd } = await legacyWorkspace([{ name: "old-card" }]);
  const paths = legacyPaths(cwd);
  // Something else lives in the same parent directory; deleting must not reach it.
  const other = join(paths.root, "another-plugin");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "keep.txt"), "keep", "utf8");

  const removed = await removeLegacy(await scanLegacy(cwd));
  assert.deepEqual(removed.removed.sort(), [paths.stats, paths.notes].sort());
  assert.deepEqual(await readdir(paths.root), ["another-plugin"], "the sibling survived");
  assert.deepEqual(await scanLegacy(cwd).then((scan) => scan.found), false, "and a second scan finds nothing");
});

test("removing when there is nothing to remove is not an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-empty-"));
  const removed = await removeLegacy(await scanLegacy(cwd));
  assert.deepEqual(removed.removed, []);
});

test("the panel's remove route answers a flat list, not a nested one", async () => {
  // `removeLegacy` already returns `{ removed: [...] }`; a route that returns `{ removed }` nests the
  // list under `removed.removed`, which reads as an empty result to any caller expecting an array.
  const { registerPanelRoutes } = await import("../lib/panel.js");
  const routes = new Map();
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (service) => (service === "webServer"
      ? { register: (entry) => { routes.set(entry.path, entry.handler); return () => {}; } }
      : undefined),
  };
  registerPanelRoutes(ctx, ctx.logger, undefined, undefined, undefined, {
    path: "unused",
    snapshot: () => ({}),
    effectiveView: () => ({}),
    update: async () => ({}),
  });

  const cwd = await mkdtemp(join(tmpdir(), "task-memory-route-"));
  const paths = legacyPaths(cwd);
  await mkdir(join(paths.notes, "sample"), { recursive: true });
  await writeFile(join(paths.notes, "sample", "SKILL.md"), "---\nname: sample\ndescription: 示例\n---\n\n## 做法\n\n内容。\n", "utf8");
  await writeFile(paths.stats, JSON.stringify({ version: 2, hits: {} }), "utf8");

  const captured = {};
  const res = { writeHead: (status) => { captured.status = status; }, end: (text) => { captured.body = JSON.parse(text); } };
  await routes.get("/api/task-memory/legacy/remove")({
    url: "/api/task-memory/legacy/remove",
    method: "POST",
    async* [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ workspace: cwd }), "utf8"); },
  }, res);

  assert.equal(captured.status, 200);
  assert.ok(Array.isArray(captured.body.removed), "the response must carry an array");
  assert.equal(captured.body.removed.length, 2, "both known artifacts are reported");
});

test("a workspace with cards but no stats file still imports", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-nostats-"));
  const notes = join(cwd, ".dsh", "task-memory", "notes", "lonely");
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, "SKILL.md"), "---\nname: lonely\ndescription: 没有统计\n---\n\n## 做法\n\n内容。\n", "utf8");

  const db = openDatabase(":memory:");
  const store = resolveStore(cwd, { db });
  const scan = await scanLegacy(cwd);
  assert.equal(scan.cards.length, 1);
  assert.equal(scan.cards[0].hits, 0, "usage counts are optional, not a blocker");
  assert.equal((await importLegacy(store, scan)).imported.length, 1);
});
