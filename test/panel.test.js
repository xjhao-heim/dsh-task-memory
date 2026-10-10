/**
 * Panel API tests.
 *
 * The panel is a browser surface over the same store, so what matters here is not the HTML but the
 * contract: routes registered, the envelope shape, the human-edit semantics (verbatim body, replaced
 * routing fields), and that a bad request fails loudly instead of answering a plausible empty list.
 *
 * A fake `webServer` captures the real handlers, and requests are driven through them as plain
 * objects — no HTTP socket is involved, so the assertions describe the route contract itself.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
// Isolates the database before anything opens it.
import "./setup.js";
import { registerPanelRoutes } from "../lib/panel.js";
import { createSettingsHandle } from "../lib/settings.js";
import { importCard, listCards, resolveStore } from "../lib/store.js";
import { formatDate } from "../lib/tiers.js";

/**
 * Build a fake host context exposing a capturing web server.
 * @param options - extra services to expose.
 * @returns the context, captured routes, and the recorded log lines.
 */
function host(options = {}) {
  const routes = new Map();
  const logs = [];
  const webServer = {
    register(entry) {
      assert.equal(routes.has(entry.path), false, `duplicate route ${entry.path}`);
      routes.set(entry.path, entry.handler);
      return () => routes.delete(entry.path);
    },
  };
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    get(service) {
      if (service === "webServer") return options.noWebServer === true ? undefined : webServer;
      if (service === "workspaceRegistry") return options.registry;
      return undefined;
    },
  };
  // Record after-write notifications. The panel is the only writer that does not go through a tool;
  // it receives the same callback the tools use, so a publish made in the UI also reaches the skill
  // catalog. Without it the Skill Center would keep serving the previous set.
  const writes = { seen: [], record: (workspace) => { writes.seen.push(workspace); } };
  return { ctx, routes, logs, writes };
}

/**
 * Build a request object the routes can read.
 * @param url - request URL.
 * @param body - JSON body for a POST.
 * @returns a minimal incoming message.
 */
function request(url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url,
    method: body === undefined ? "GET" : "POST",
    async* [Symbol.asyncIterator]() {
      yield* payload;
    },
  };
}

/**
 * Build a response recorder.
 * @returns the response object plus a reader for what was sent.
 */
function response() {
  const captured = {};
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body;
    },
    json() {
      return JSON.parse(captured.body);
    },
  };
}

/**
 * Invoke one captured route.
 * @param routes - captured route table.
 * @param path - route path.
 * @param url - request URL including query.
 * @param body - optional JSON body.
 * @returns the status and parsed payload.
 */
async function call(routes, path, url, body) {
  const handler = routes.get(path);
  assert.ok(handler, `${path} must be registered`);
  const res = response();
  await handler(request(url, body), res);
  return { status: res.captured.status, payload: res.json() };
}

/**
 * Create an isolated workspace directory.
 * @returns the workspace path.
 */
async function workspace() {
  return await mkdtemp(join(tmpdir(), "task-memory-panel-"));
}

test("registers the panel routes and reports them once", () => {
  const { ctx, routes, logs } = host();
  const dispose = registerPanelRoutes(ctx, ctx.logger);

  assert.deepEqual([...routes.keys()].sort(), [
    "/api/task-memory/card",
    "/api/task-memory/cards",
    "/api/task-memory/delete",
    "/api/task-memory/forgotten",
    "/api/task-memory/legacy/import",
    "/api/task-memory/legacy/preview",
    "/api/task-memory/legacy/remove",
    "/api/task-memory/purge",
    "/api/task-memory/save",
    "/api/task-memory/search",
    "/api/task-memory/settings",
    "/api/task-memory/workspaces",
  ]);
  assert.equal(logs.filter((line) => line.includes("memory panel API mounted")).length, 1);

  dispose();
  assert.equal(routes.size, 0, "disposal must remove every route");
});

test("a profile without a web server mounts nothing and says so", () => {
  const { ctx, routes, logs } = host({ noWebServer: true });
  const dispose = registerPanelRoutes(ctx, ctx.logger);
  assert.equal(dispose, undefined);
  assert.equal(routes.size, 0);
  assert.equal(logs.some((line) => line.includes("no webServer")), true);
});

test("the panel notifies after a write so a UI publish reaches the skill catalog", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "pub-me", description: "d", body: "## x\n\ny", published: true,
  });
  // The notification is fire-and-forget, so let the microtask queue drain before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes.seen, [cwd], "saving must notify once for this workspace");

  await call(routes, "/api/task-memory/delete", "/api/task-memory/delete", { workspace: cwd, name: "pub-me" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes.seen, [cwd, cwd], "deleting must notify too");
});

test("a rejected panel write does not notify", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  const bad = await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "bad", description: "", body: "## x\n\ny",
  });
  assert.equal(bad.status, 400);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes.seen, [], "a refused write changed nothing, so nothing needs refreshing");
});

test("card rows carry the recency tier and a readable age", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "fresh", description: "刚写的卡", body: "## x\n\ny",
  });

  const list = await call(routes, "/api/task-memory/cards", `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`);
  const row = list.payload.cards[0];
  assert.equal(row.tier, "recent");
  assert.equal(row.tierLabel, "近期");
  assert.equal(row.ageLabel, "今天");
  assert.equal(typeof row.days, "number");
});

test("the forgotten route lists aged cards and purge removes only those named", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  for (const [name, description] of [["keeper", "要保留的卡"], ["doomed", "要清理的卡"]]) {
    await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
      workspace: cwd, mode: "create", name, description, body: "## x\n\ny",
    });
  }
  // Age one card past the forgotten boundary by re-importing it with an old date, the way a real
  // year would.
  const old = formatDate(Date.now() - 400 * 86_400_000);
  await importCard(resolveStore(cwd), { name: "doomed", description: "要清理的卡", created: old, updated: old, body: "## x\n\ny" });

  const forgotten = await call(routes, "/api/task-memory/forgotten", `/api/task-memory/forgotten?workspace=${encodeURIComponent(cwd)}`);
  assert.deepEqual(forgotten.payload.forgotten.map((row) => row.name), ["doomed"],
    "only the aged card is listed");

  // Purging is explicit and bounded: it removes what it was told to, and nothing else.
  const purged = await call(routes, "/api/task-memory/purge", "/api/task-memory/purge", {
    workspace: cwd, names: ["doomed"],
  });
  assert.deepEqual(purged.payload.removed, ["doomed"]);
  const left = await call(routes, "/api/task-memory/cards", `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`);
  assert.deepEqual(left.payload.cards.map((row) => row.name), ["keeper"]);

  // A purge with no names is refused rather than treated as "everything".
  const empty = await call(routes, "/api/task-memory/purge", "/api/task-memory/purge", { workspace: cwd, names: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.payload.error, /需要给出/);
});

test("the cards route filters by tier and returns the pickers' data", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record, { past: 7, old: 30, ancient: 90, forgotten: 365 }, ["recent"]);
  const cwd = await workspace();

  // Two cards with unrelated content, one aged past the forgotten boundary.
  for (const [name, description] of [["fresh", "刚写的卡"], ["stale-one", "很久以前写的卡"]]) {
    await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
      workspace: cwd, mode: "create", name, description, body: "## x\n\ny",
    });
  }
  const old = formatDate(Date.now() - 400 * 86_400_000);
  await importCard(resolveStore(cwd), { name: "stale-one", description: "很久以前写的卡", created: old, updated: old, body: "## x\n\ny" });

  const base = `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`;
  const all = await call(routes, "/api/task-memory/cards", base);
  assert.equal(all.payload.total, 2);
  assert.deepEqual(all.payload.cards.map((row) => row.name).sort(), ["fresh", "stale-one"], "no filter shows all");
  assert.deepEqual(all.payload.defaultTiers, ["recent"], "the configured default travels to the panel");
  assert.deepEqual(all.payload.dateBounds.max, formatDate(Date.now()), "the bounds describe the data");
  assert.equal(all.payload.days.length, 2, "one entry per day that holds a card");
  assert.equal(all.payload.days.reduce((sum, day) => sum + day.count, 0), 2);

  const recentOnly = await call(routes, "/api/task-memory/cards", `${base}&tiers=recent`);
  assert.deepEqual(recentOnly.payload.cards.map((row) => row.name), ["fresh"]);

  const forgottenOnly = await call(routes, "/api/task-memory/cards", `${base}&tiers=forgotten`);
  assert.deepEqual(forgottenOnly.payload.cards.map((row) => row.name), ["stale-one"],
    "the forgotten tier is reachable, not hidden, once asked for");

  // An unrecognised tier list means "no filter" rather than "match nothing": an empty list would
  // render as a broken panel.
  const bogus = await call(routes, "/api/task-memory/cards", `${base}&tiers=nonsense`);
  assert.equal(bogus.payload.cards.length, 2);
});

test("the cards route filters by date range", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();
  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "today", description: "今天的卡", body: "## x\n\ny",
  });

  const base = `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`;
  const today = formatDate(Date.now());
  const yesterday = formatDate(Date.now() - 86_400_000);

  assert.equal((await call(routes, "/api/task-memory/cards", `${base}&from=${today}&to=${today}`)).payload.cards.length, 1);
  assert.equal((await call(routes, "/api/task-memory/cards", `${base}&from=${yesterday}&to=${yesterday}`)).payload.cards.length, 0);
  assert.equal((await call(routes, "/api/task-memory/cards", `${base}&to=${yesterday}`)).payload.cards.length, 0, "an upper bound excludes it");
  assert.equal((await call(routes, "/api/task-memory/cards", `${base}&from=${today}`)).payload.cards.length, 1, "a lower bound includes it");
});

test("the settings route reads, fills in defaults, and writes through the shared handle", async () => {
  const { ctx, routes, writes } = host();
  const env = await mkdtemp(join(tmpdir(), "task-memory-settings-route-"));
  const handle = createSettingsHandle({ autoCapture: true }, { DSH_HOME: env });
  registerPanelRoutes(ctx, ctx.logger, writes.record, undefined, undefined, handle);

  // Reading is also what makes the local file complete: every parameter the file did not carry is
  // written with the value the plugin actually runs with, and the page gets that effective view.
  const initial = await call(routes, "/api/task-memory/settings", "/api/task-memory/settings");
  assert.match(initial.payload.configPath, /settings\.json$/);
  assert.equal(initial.payload.settings.autoCapture, true, "the default was written to the file");
  assert.equal(initial.payload.effective.maxCatalogCards, 50);
  assert.deepEqual(initial.payload.effective.defaultTiers, ["recent"]);
  assert.ok(initial.payload.initialized.includes("maxBodyChars"), "and it reports what it filled in");

  const saved = await call(routes, "/api/task-memory/settings", "/api/task-memory/settings", {
    autoCapture: false, defaultTiers: ["recent", "past"],
  });
  assert.equal(saved.payload.settings.autoCapture, false);
  assert.deepEqual(saved.payload.settings.defaultTiers, ["recent", "past"]);
  assert.equal(handle.effective().autoCapture, false, "the live handle sees the change at once");

  const rejected = await call(routes, "/api/task-memory/settings", "/api/task-memory/settings", {
    tierDays: { past: 30, old: 7 },
  });
  assert.equal(rejected.status, 400, "an unusable ladder is refused, not stored");
  assert.equal(handle.snapshot().tierDays.past, 7, "and the stored ladder is untouched");
});

test("saving from the panel stores the body verbatim instead of merging it", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd,
    mode: "create",
    name: "panel-card",
    description: "面板创建的卡",
    triggers: ["甲", "乙"],
    body: "## 做法\n\n第一步。\n\n## 验证\n\n看结果。",
  });

  // A human deleting a section means it is gone — unlike the model's merge, which preserves it.
  const saved = await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd,
    mode: "update",
    name: "panel-card",
    description: "面板创建的卡",
    triggers: ["丙"],
    body: "## 做法\n\n改写后的第一步。",
  });

  assert.equal(saved.status, 200);
  const stored = await listCards(resolveStore(cwd));
  assert.match(stored[0].body, /改写后的第一步/);
  assert.doesNotMatch(stored[0].body, /## 验证/, "a section the editor removed must not come back");
  assert.doesNotMatch(stored[0].triggers.join(" "), /甲/, "a trigger the editor removed must not come back");
  assert.match(stored[0].triggers.join(" "), /丙/);
});

test("list returns rows with routing metadata and load counts", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd,
    mode: "create",
    name: "listed-card",
    description: "会被列出来的卡",
    triggers: ["触发词"],
    tags: ["标签"],
    body: "## 做法\n\n内容。",
  });

  const list = await call(routes, "/api/task-memory/cards", `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`);
  assert.equal(list.status, 200);
  assert.equal(list.payload.ok, true);
  assert.equal(list.payload.cards.length, 1);
  const row = list.payload.cards[0];
  assert.equal(row.name, "listed-card");
  assert.equal(row.description, "会被列出来的卡");
  assert.deepEqual(row.triggers, ["触发词"]);
  assert.deepEqual(row.tags, ["标签"]);
  assert.equal(row.status, "verified");
  assert.equal(row.revision, 1);
  assert.equal(row.hits, 0);
});

test("reading one card returns its body and asset list", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd,
    mode: "create",
    name: "read-card",
    description: "读一张卡",
    body: "## 做法\n\n正文内容。",
  });
  const detail = await call(routes, "/api/task-memory/card",
    `/api/task-memory/card?workspace=${encodeURIComponent(cwd)}&name=read-card`);

  assert.equal(detail.status, 200);
  assert.match(detail.payload.body, /正文内容/);
  assert.deepEqual(detail.payload.assets, []);
  // There is no file any more, so the detail carries the card's own fields instead of a raw path.
  assert.equal(detail.payload.card.name, "read-card");
  assert.equal(detail.payload.card.tierLabel, "近期");
});

test("create refuses an existing name and update refuses a missing one", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  const missing = await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "update", name: "nope", description: "d", body: "## x\n\ny",
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.ok, false);
  assert.match(missing.payload.error, /没有名为/);

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "dup", description: "d", body: "## x\n\ny",
  });
  const duplicate = await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "dup", description: "d", body: "## x\n\ny",
  });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.payload.error, /已存在/);
});

test("an empty workspace path fails instead of guessing one", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);

  const missing = await call(routes, "/api/task-memory/cards", "/api/task-memory/cards");
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /workspace path is required/);

  const relative = await call(routes, "/api/task-memory/cards", "/api/task-memory/cards?workspace=relative/path");
  assert.equal(relative.status, 400);
  assert.match(relative.payload.error, /absolute/);
});

test("empty required fields are refused with a readable reason", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  for (const [body, expected] of [
    [{ mode: "create", description: "d", body: "b" }, /名字不能为空/],
    [{ mode: "create", name: "x", body: "b" }, /描述不能为空/],
    [{ mode: "create", name: "x", description: "d" }, /正文不能为空/],
  ]) {
    const result = await call(routes, "/api/task-memory/save", "/api/task-memory/save", { workspace: cwd, ...body });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, expected);
  }
});

test("deleting removes the card and reports a missing one", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "doomed", description: "d", body: "## x\n\ny",
  });
  const removed = await call(routes, "/api/task-memory/delete", "/api/task-memory/delete", { workspace: cwd, name: "doomed" });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.removed, "doomed");
  assert.deepEqual(await listCards(resolveStore(cwd)), []);

  const again = await call(routes, "/api/task-memory/delete", "/api/task-memory/delete", { workspace: cwd, name: "doomed" });
  assert.equal(again.status, 400);
  assert.match(again.payload.error, /没有名为/);
});

test("search matches body text and returns an empty list for an empty query", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "findme", description: "d", body: "## 做法\n\n独一无二的正文标记。",
  });

  const hit = await call(routes, "/api/task-memory/search", `/api/task-memory/search?workspace=${encodeURIComponent(cwd)}&q=独一无二`);
  assert.equal(hit.payload.matches.length, 1);
  assert.equal(hit.payload.matches[0].name, "findme");

  const empty = await call(routes, "/api/task-memory/search", `/api/task-memory/search?workspace=${encodeURIComponent(cwd)}`);
  assert.deepEqual(empty.payload.matches, []);
});

test("the workspace list reports a card count per workspace", async () => {
  const cwd = await workspace();
  const { ctx, routes, writes } = host({
    registry: { list: () => [{ id: "w1", path: cwd, title: "测试工作区" }] },
  });
  registerPanelRoutes(ctx, ctx.logger, writes.record);

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "counted", description: "d", body: "## x\n\ny",
  });

  const list = await call(routes, "/api/task-memory/workspaces", "/api/task-memory/workspaces");
  assert.equal(list.payload.workspaces.length, 1);
  assert.equal(list.payload.workspaces[0].title, "测试工作区");
  assert.equal(list.payload.workspaces[0].cards, 1);
});

test("a malformed JSON body is refused rather than treated as empty", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const handler = routes.get("/api/task-memory/save");
  const res = response();
  await handler({
    url: "/api/task-memory/save",
    method: "POST",
    async* [Symbol.asyncIterator]() {
      yield Buffer.from("{not json", "utf8");
    },
  }, res);
  assert.equal(res.captured.status, 400);
  assert.match(res.json().error, /not valid JSON/);
});

test("an oversized body is refused", async () => {
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const handler = routes.get("/api/task-memory/save");
  const res = response();
  const big = Buffer.alloc(600 * 1024, 0x61);
  await handler({
    url: "/api/task-memory/save",
    method: "POST",
    async* [Symbol.asyncIterator]() {
      yield big;
    },
  }, res);
  assert.equal(res.captured.status, 400);
  assert.match(res.json().error, /exceeds/);
});

test("a legacy card with broken frontmatter is reported rather than silently dropped", async () => {
  // A database row cannot be malformed, so the case that still matters is the import: a card file
  // the reader cannot parse must be named in the preview instead of disappearing during a migration.
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();
  const broken = join(cwd, ".dsh", "task-memory", "notes", "broken-one");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "no frontmatter here", "utf8");

  const preview = await call(routes, "/api/task-memory/legacy/preview",
    `/api/task-memory/legacy/preview?workspace=${encodeURIComponent(cwd)}`);
  assert.equal(preview.payload.found, true);
  assert.equal(preview.payload.totals.unreadable, 1, "the unreadable card must be counted");
  assert.match(preview.payload.unreadable[0].reason, /frontmatter/);
  assert.equal(preview.payload.totals.cards, 0, "and nothing is imported from it");
});

test("every field the client reads off a list row is actually sent", async () => {
  // A field that stops being sent does not break anything loudly: the client reads `undefined`, and
  // a comparison written as `field !== null` is then permanently true. That is how every card in the
  // panel came to wear a "读取失败" badge after the store moved into the database. Nothing tested the
  // two sides against each other, so this pins the contract: what the list route emits must cover
  // what the client reads.
  const { ctx, routes, writes } = host();
  registerPanelRoutes(ctx, ctx.logger, writes.record);
  const cwd = await workspace();
  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd,
    mode: "create",
    name: "field-contract",
    description: "字段契约",
    whenToUse: "任何时候",
    triggers: ["触发"],
    tags: ["标签"],
    body: "## 做法\n\n内容。",
  });

  const listed = await call(routes, "/api/task-memory/cards", `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`);
  const sent = new Set(Object.keys(listed.payload.cards[0]));

  const here = dirname(fileURLToPath(import.meta.url));
  const client = await readFile(join(here, "..", "client.js"), "utf8");
  // Only `card.<field>` reads describe this list row; other objects in the file reuse the name.
  const read = new Set([...client.matchAll(/\bcard\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  assert.ok(read.size > 5, `the client must read several fields, found: ${[...read].join(", ")}`);

  const missing = [...read].filter((field) => !sent.has(field));
  assert.deepEqual(missing, [], `客户端读了但宿主没发的字段：${missing.join(", ")}`);
});

test("the client does not test presence with a null-only comparison", async () => {
  // `undefined !== null` is true, so `!== null` cannot express "this field is absent". Any presence
  // check on a value that may be missing has to use `!= null` or Object.hasOwn.
  const here = dirname(fileURLToPath(import.meta.url));
  const client = await readFile(join(here, "..", "client.js"), "utf8");
  const violations = client.split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /\.[A-Za-z_$][\w$]*\s*!==\s*null\b/.test(line) && !/\.current\s*!==\s*null/.test(line));
  assert.deepEqual(violations, [], `存在性判断不要写 !== null（undefined 会漏过）：\n`
    + violations.map(({ line, number }) => `  ${number}: ${line}`).join("\n"));
});
