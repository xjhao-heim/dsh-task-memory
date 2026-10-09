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
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerPanelRoutes } from "../lib/panel.js";

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
  return { ctx, routes, logs };
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
    "/api/task-memory/save",
    "/api/task-memory/search",
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

test("saving from the panel stores the body verbatim instead of merging it", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  const stored = await readFile(join(cwd, ".dsh", "task-memory", "notes", "panel-card", "SKILL.md"), "utf8");
  assert.match(stored, /改写后的第一步/);
  assert.doesNotMatch(stored, /## 验证/, "a section the editor removed must not come back");
  assert.doesNotMatch(stored, /甲/, "a trigger the editor removed must not come back");
  assert.match(stored, /丙/);
});

test("list returns rows with routing metadata and load counts", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  assert.equal(row.problem, null);
});

test("reading one card returns its body, raw text, and asset list", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  assert.match(detail.payload.raw, /^---\n/, "the editor needs the raw file, frontmatter included");
  assert.match(detail.payload.raw, /name: read-card/);
  assert.deepEqual(detail.payload.assets, []);
  assert.match(detail.payload.path, /read-card/);
});

test("create refuses an existing name and update refuses a missing one", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);

  const missing = await call(routes, "/api/task-memory/cards", "/api/task-memory/cards");
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /workspace path is required/);

  const relative = await call(routes, "/api/task-memory/cards", "/api/task-memory/cards?workspace=relative/path");
  assert.equal(relative.status, 400);
  assert.match(relative.payload.error, /absolute/);
});

test("empty required fields are refused with a readable reason", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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

test("deleting removes the card directory and reports a missing one", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
  const cwd = await workspace();

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "doomed", description: "d", body: "## x\n\ny",
  });
  const removed = await call(routes, "/api/task-memory/delete", "/api/task-memory/delete", { workspace: cwd, name: "doomed" });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.removed, "doomed");
  assert.deepEqual((await readdir(join(cwd, ".dsh", "task-memory", "notes"))), []);

  const again = await call(routes, "/api/task-memory/delete", "/api/task-memory/delete", { workspace: cwd, name: "doomed" });
  assert.equal(again.status, 400);
  assert.match(again.payload.error, /没有名为/);
});

test("search matches body text and returns an empty list for an empty query", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  const { ctx, routes } = host({
    registry: { list: () => [{ id: "w1", path: cwd, title: "测试工作区" }] },
  });
  registerPanelRoutes(ctx, ctx.logger);

  await call(routes, "/api/task-memory/save", "/api/task-memory/save", {
    workspace: cwd, mode: "create", name: "counted", description: "d", body: "## x\n\ny",
  });

  const list = await call(routes, "/api/task-memory/workspaces", "/api/task-memory/workspaces");
  assert.equal(list.payload.workspaces.length, 1);
  assert.equal(list.payload.workspaces[0].title, "测试工作区");
  assert.equal(list.payload.workspaces[0].cards, 1);
});

test("a malformed JSON body is refused rather than treated as empty", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
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

test("a malformed card still lists with its problem attached", async () => {
  const { ctx, routes } = host();
  registerPanelRoutes(ctx, ctx.logger);
  const cwd = await workspace();
  const broken = join(cwd, ".dsh", "task-memory", "notes", "broken-one");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "no frontmatter here", "utf8");

  const list = await call(routes, "/api/task-memory/cards", `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`);
  const row = list.payload.cards.find((card) => card.name === "broken-one");
  assert.ok(row, "an unreadable card must still be visible in the panel");
  assert.match(row.problem, /frontmatter/);
});
