/**
 * Plugin tests.
 *
 * These drive `apply()` against a fake host: the same registration calls the real loader makes, with
 * enough of the tool/skill/prompt registries to observe what the plugin actually contributes. That
 * is what makes the interesting claims testable without a running Harness — that the catalog is one
 * line per card, that `save` refuses a duplicate, and that the loaded card body is the card.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply, resolveConfig } from "../lib/index.js";

/**
 * Build a fake host context recording every contribution.
 * @param options - cwd for tool executions and whether to expose the prompt registry.
 * @returns the context, the registered tools, the provider, and the recorded prompt sections.
 */
function host(options = {}) {
  const tools = new Map();
  const sections = [];
  let provider;
  // The real host exposes an injected service both as a direct property (`ctx.skills`) and through
  // `ctx.get(name)`; the fake has to do the same or it would not exercise the real call shape.
  const toolRegistry = { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } };
  const skillRegistry = {
    registerProvider: (create) => {
      provider = create({ signal: new AbortController().signal, invalidate() {} });
      return () => { provider = undefined; };
    },
  };
  const promptRegistry = {
    section: (section) => { sections.push(section); return () => {}; },
    getSectionOrder: () => 2300,
  };
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: toolRegistry,
    skills: skillRegistry,
    get(service) {
      if (service === "tools") return toolRegistry;
      if (service === "skills") return skillRegistry;
      if (service === "systemPrompt") return options.systemPrompt === false ? undefined : promptRegistry;
      return undefined;
    },
    effect: (factory) => { factory(); return () => {}; },
  };
  return { ctx, tools, sections, provider: () => provider };
}

/**
 * Build a tool execution context carrying one workspace.
 * @param cwd - session working directory.
 * @returns a tool run context.
 */
function execution(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };
}

/**
 * Invoke a registered tool by name and return its rendered text.
 * @param tools - registered tools map.
 * @param name - tool name.
 * @param args - tool arguments.
 * @param cwd - session working directory.
 * @returns the tool's text output.
 */
async function call(tools, name, args, cwd) {
  const definition = tools.get(name);
  assert.ok(definition, `${name} must be registered`);
  const value = await definition.execute(args, execution(cwd));
  return value.text;
}

const CARD = {
  name: "qt-tableview-flicker",
  description: "QTableView 滚动闪烁",
  whenToUse: "表格滚动时闪烁",
  triggers: ["表格闪烁", "setUniformRowHeights"],
  tags: ["qt"],
  body: "## 适用场景\n\n大表格滚动闪烁。\n\n## 做法\n\n开启 uniformRowHeights。",
};

test("register the four memory tools and one prompt section", async () => {
  const { ctx, tools, sections } = host();
  apply(ctx, {});

  assert.deepEqual([...tools.keys()].sort(), [
    "task_memory_index",
    "task_memory_load",
    "task_memory_save",
    "task_memory_search",
  ]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "dsh-task-memory");
  assert.match(sections[0].text, /不要重新从头分析/);
  assert.match(sections[0].text, /task_memory_save/);
});

test("refuses to mount without the skills service", () => {
  const ctx = {
    logger: {},
    get: (service) => (service === "tools" ? { register: () => () => {} } : undefined),
    effect: () => () => {},
  };
  assert.throws(() => apply(ctx, {}), /skills service/);
});

test("the catalog exposes one line per card and no body", async () => {
  const { ctx, tools, provider } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", { ...CARD, publish: true }, cwd);

  const candidates = await provider().list({ cwd });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, CARD.name);
  assert.match(candidates[0].description, /QTableView 滚动闪烁/);
  assert.match(candidates[0].description, /触发：表格闪烁、setUniformRowHeights/);
  assert.equal(candidates[0].content, undefined, "the index must not carry card bodies");
  assert.equal(candidates[0].source, "runtime");
  assert.ok(candidates[0].rank > 0);

  const loaded = await provider().get(candidates[0], { cwd });
  assert.equal(loaded.content, CARD.body);
  assert.equal(loaded.resourceBase.kind, "directory");
});

test("an unpublished card stays out of the skill catalog but remains usable", async () => {
  const { ctx, tools, provider } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  // Cards are this plugin's own storage. The harness skill catalog is the curated surface the Skill
  // Center page lists, so publishing every card would turn it into a dumping ground for memories.
  assert.deepEqual(await provider().list({ cwd }), [], "a plain save must not publish");

  // It is still a real card: reachable through the tools and through the injected index.
  assert.match(await call(tools, "task_memory_index", {}, cwd), /qt-tableview-flicker/);
  assert.match(await call(tools, "task_memory_load", { name: CARD.name }, cwd), /开启 uniformRowHeights/);
});

test("publishing is opt-in and sticky until explicitly withdrawn", async () => {
  const { ctx, tools, provider } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);
  assert.deepEqual(await provider().list({ cwd }), []);

  await call(tools, "task_memory_save", { ...CARD, mode: "update", publish: true }, cwd);
  assert.equal((await provider().list({ cwd })).length, 1);

  // An ordinary later update must not silently withdraw it.
  await call(tools, "task_memory_save", { ...CARD, mode: "update", body: "## 做法\n\n修订后的做法。" }, cwd);
  assert.equal((await provider().list({ cwd })).length, 1, "publication survives an ordinary update");

  await call(tools, "task_memory_save", { ...CARD, mode: "update", publish: false }, cwd);
  assert.deepEqual(await provider().list({ cwd }), [], "withdrawing is explicit");
});

test("the save result tells the model whether the card was published", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});

  const plain = await call(tools, "task_memory_save", CARD, cwd);
  assert.match(plain, /未上架/);
  assert.match(plain, /技能中心/);

  const published = await call(tools, "task_memory_save", {
    name: "published-card",
    description: "rebase 冲突解决流程",
    triggers: ["rebase"],
    body: "## 做法\n\n先把冲突文件列出来。",
    publish: true,
  }, cwd);
  assert.match(published, /已上架/);
});

test("the catalog is capped and keeps the most-used cards", async () => {
  const { ctx, tools, provider } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, { maxCatalogCards: 2 });

  // Deliberately unrelated tasks: near-identical descriptions would (correctly) be refused by the
  // duplicate guard and this test would then be measuring the wrong thing.
  const distinct = [
    { name: "card-git", description: "rebase 冲突解决流程", triggers: ["rebase"] },
    { name: "card-png", description: "导出 PNG 透明背景处理", triggers: ["png 透明"] },
    { name: "card-ssh", description: "SSH 跳板机端口转发", triggers: ["跳板机"] },
  ];
  for (const card of distinct) {
    await call(tools, "task_memory_save", {
      ...card, publish: true, body: `## 做法\n\n${card.description}的做法。`,
    }, cwd);
  }
  // Load two of them so they outrank the third by hit count.
  for (const name of ["card-git", "card-png"]) {
    await provider().get({ locator: { workspace: cwd, name } }, { cwd });
  }

  const candidates = await provider().list({ cwd });
  assert.equal(candidates.length, 2, "the injected catalog must stay bounded");
  assert.deepEqual(candidates.map((item) => item.name), ["card-git", "card-png"]);
});

test("save refuses a near-duplicate and names the existing card", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const text = await call(tools, "task_memory_save", {
    name: "table-scroll-shimmer",
    description: "表格滚动时闪烁",
    body: "## 做法\n\n同样的做法。",
    triggers: ["表格闪烁"],
  }, cwd);

  assert.match(text, /没有创建新卡/);
  assert.match(text, /qt-tableview-flicker/);
  assert.equal((await readdir(join(cwd, ".dsh", "task-memory", "notes"))).length, 1);
});

test("save creates a genuinely different task and reports related cards", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const text = await call(tools, "task_memory_save", {
    name: "qt-dialog-focus",
    description: "弹窗抢焦点",
    body: "## 做法\n\n设置 Qt::NoFocus。",
    tags: ["qt"],
  }, cwd);

  assert.match(text, /已创建记忆卡/);
  assert.equal((await readdir(join(cwd, ".dsh", "task-memory", "notes"))).length, 2);
});

test("force-create overrides the duplicate guard", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const text = await call(tools, "task_memory_save", {
    name: "table-scroll-shimmer",
    description: "表格滚动时闪烁",
    body: "## 做法\n\n另一条路径。",
    mode: "force-create",
  }, cwd);

  assert.match(text, /已创建记忆卡/);
  assert.equal((await readdir(join(cwd, ".dsh", "task-memory", "notes"))).length, 2);
});

test("update folds into the named card and keeps the file count", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const text = await call(tools, "task_memory_save", {
    ...CARD,
    mode: "update",
    body: "## 做法\n\n开启 uniformRowHeights 并设置滚动模式。",
  }, cwd);

  assert.match(text, /已更新记忆卡/);
  assert.match(text, /r2/);
  assert.equal((await readdir(join(cwd, ".dsh", "task-memory", "notes"))).length, 1);

  const file = join(cwd, ".dsh", "task-memory", "notes", CARD.name, "SKILL.md");
  const stored = await readFile(file, "utf8");
  assert.match(stored, /## 适用场景/, "the merge must keep sections the update did not mention");
  assert.match(stored, /滚动模式/);
});

test("load returns the body, metadata, and asset list", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const text = await call(tools, "task_memory_load", { name: CARD.name }, cwd);
  assert.match(text, /# qt-tableview-flicker/);
  assert.match(text, /开启 uniformRowHeights/);
  assert.match(text, /状态：verified/);

  const missing = await call(tools, "task_memory_load", { name: "no-such-card" }, cwd);
  assert.match(missing, /没有名为/);
});

test("index lists cards, filters, and points at the loader", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const all = await call(tools, "task_memory_index", {}, cwd);
  assert.match(all, /任务记忆索引：1 张卡/);
  assert.match(all, /qt-tableview-flicker/);
  assert.match(all, /task_memory_search/);

  const filtered = await call(tools, "task_memory_index", { query: "不存在的关键词" }, cwd);
  assert.match(filtered, /没有符合条件的卡片/);

  const empty = await call(tools, "task_memory_index", {}, await mkdtemp(join(tmpdir(), "task-memory-empty-")));
  assert.match(empty, /还没有任务记忆卡/);
});

test("search finds body text that the index line does not contain", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const hit = await call(tools, "task_memory_search", { query: "uniformRowHeights" }, cwd);
  assert.match(hit, /匹配 1 张卡/);
  assert.match(hit, /qt-tableview-flicker/);

  const miss = await call(tools, "task_memory_search", { query: "nothing-here" }, cwd);
  assert.match(miss, /没有匹配/);

  const invalid = await call(tools, "task_memory_search", { query: "(", regex: true }, cwd);
  assert.match(invalid, /检索表达式无效/);
});

test("save warns about credential-shaped content but still stores", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  const text = await call(tools, "task_memory_save", {
    name: "leaky-card",
    description: "包含密钥的例子",
    body: "## 配置\n\napi_key = sk-abcdefghijklmnopqrstuvwxyz",
  }, cwd);

  assert.match(text, /疑似密钥/);
  assert.match(text, /已创建记忆卡/);
});

test("a tool call without a workspace fails instead of guessing a directory", async () => {
  const { ctx, tools } = host();
  apply(ctx, {});
  await assert.rejects(() => call(tools, "task_memory_index", {}, undefined), /working directory/);
});

test("the provider contributes nothing when no cwd is known", async () => {
  const { ctx, provider } = host();
  apply(ctx, {});
  assert.deepEqual(await provider().list({}), []);
  assert.equal(await provider().get({ locator: { name: "x" } }, {}), undefined);
});

test("resolveConfig clamps unusable values", () => {
  assert.equal(resolveConfig(undefined).maxCatalogCards, 50);
  assert.equal(resolveConfig({ maxCatalogCards: 0 }).maxCatalogCards, 50);
  assert.equal(resolveConfig({ maxCatalogCards: -3 }).maxCatalogCards, 50);
  assert.equal(resolveConfig({ maxCatalogCards: 5 }).maxCatalogCards, 5);
  assert.equal(resolveConfig({ maxBodyChars: 100 }).maxBodyChars, 100);
  assert.equal(resolveConfig({ includeSystemPrompt: false }).includeSystemPrompt, false);
  assert.equal(resolveConfig({}).includeSystemPrompt, true);
});

test("an oversized card body is truncated with a pointer to the file", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, { maxBodyChars: 40 });
  await call(tools, "task_memory_save", { ...CARD, name: "long-card", description: "长正文" }, cwd);

  const text = await call(tools, "task_memory_load", { name: "long-card" }, cwd);
  assert.match(text, /已截断/);
  assert.ok(text.length < 400, "the truncation must actually bound the output");
});
