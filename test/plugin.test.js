/**
 * Plugin tests.
 *
 * These drive `apply()` against a fake host: the same registration calls the real loader makes, with
 * enough of the tool/skill/prompt registries to observe what the plugin actually contributes. That
 * is what makes the interesting claims testable without a running Harness — that the catalog is one
 * line per card, that `save` refuses a duplicate, and that the loaded card body is the card.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Isolates the database before anything opens it.
import "./setup.js";
import { apply, resolveConfig } from "../lib/index.js";
import { openDatabase } from "../lib/db.js";
import { importCard, listCards, resolveStore } from "../lib/store.js";

/**
 * Seed a card with controlled dates into the same database the plugin uses.
 *
 * The plugin opens the shared connection lazily, so a test that seeded a separate database would be
 * writing somewhere the plugin never looks. Every seeded card therefore goes through
 * `resolveStore(cwd)` with no override, which is the store the tools themselves resolve.
 *
 * @param cwd - workspace path.
 * @param card - card fields, dates included.
 */
async function seedCard(cwd, card) {
  await importCard(resolveStore(cwd), card);
}
import { formatDate } from "../lib/tiers.js";

/**
 * Build a fake host context recording every contribution.
 * @param options - cwd for tool executions and whether to expose the prompt registry.
 * @returns the context, the registered tools, the provider, and the recorded prompt sections.
 */
function host(options = {}) {
  const tools = new Map();
  const sections = [];
  let provider;
  // Count invalidations: `control.invalidate()` is how the plugin tells the registry its catalog
  // changed, and a missed call means the Skill Center keeps serving the previous set.
  const invalidations = { count: 0 };
  // The real host exposes an injected service both as a direct property (`ctx.skills`) and through
  // `ctx.get(name)`; the fake has to do the same or it would not exercise the real call shape.
  const toolRegistry = { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } };
  const skillRegistry = {
    registerProvider: (create) => {
      const controller = new AbortController();
      provider = create({
        signal: controller.signal,
        invalidate() { invalidations.count += 1; },
      });
      return () => {
        controller.abort();
        provider = undefined;
      };
    },
  };
  const promptRegistry = {
    section: (section) => { sections.push(section); return () => {}; },
    getSectionOrder: () => 2300,
  };
  // Agent-scoped prompt sections: the injected index is registered per agent, so the fake records
  // those separately from the global workflow section.
  const agentSections = [];
  const agentHandlers = [];
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
    on(event, handler) {
      if (event === "agent/created") agentHandlers.push(handler);
    },
    effect: (factory) => { factory(); return () => {}; },
  };
  return {
    ctx, tools, sections, agentSections, agentHandlers, invalidations,
    provider: () => provider,
  };
}

/**
 * Fire the plugin's `agent/created` listener for one workspace, the way the host does, and return
 * the prompt sections it registered for that agent.
 *
 * @param harness - the object returned by {@link host}.
 * @param cwd - the session working directory.
 * @returns the agent-scoped sections.
 */
async function emitAgentCreated(harness, cwd) {
  for (const listener of harness.agentHandlers) {
    await listener({
      agent: {
        session: { header: { cwd } },
        ctx: {
          get: () => ({
            section: (section) => { harness.agentSections.push(section); return () => {}; },
            getSectionOrder: () => 2300,
          }),
          effect: () => () => {},
        },
      },
    });
  }
  return harness.agentSections;
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
    "task_memory_asset",
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
  // A card has no file any more, so the provider reports an opaque resource base rather than a
  // directory a relative reference could resolve against.
  assert.equal(loaded.resourceBase.kind, "opaque");
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

test("saving a card invalidates the skill catalog so a publish takes effect at once", async () => {
  const { ctx, tools, invalidations } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});

  // `control.invalidate()` bumps the registry revision, which is part of the registry's cache key —
  // so the next `snapshot()` re-reads this provider instead of serving the previous set. Without it
  // a card could be published and the Skill Center would keep showing the old catalog.
  const before = invalidations.count;
  await call(tools, "task_memory_save", CARD, cwd);
  assert.ok(invalidations.count > before, "creating a card must invalidate the catalog");

  const afterCreate = invalidations.count;
  await call(tools, "task_memory_save", { ...CARD, mode: "update", publish: true }, cwd);
  assert.ok(invalidations.count > afterCreate, "publishing must invalidate the catalog");

  const afterPublish = invalidations.count;
  await call(tools, "task_memory_save", { ...CARD, mode: "update", publish: false }, cwd);
  assert.ok(invalidations.count > afterPublish, "withdrawing must invalidate the catalog");
});

test("a refused duplicate does not invalidate the catalog", async () => {
  const { ctx, tools, invalidations } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});
  await call(tools, "task_memory_save", CARD, cwd);

  const before = invalidations.count;
  await call(tools, "task_memory_save", {
    name: "table-scroll-shimmer",
    description: "表格滚动时闪烁",
    body: "## 做法\n\n同样的做法。",
    triggers: ["表格闪烁"],
  }, cwd);
  assert.equal(invalidations.count, before, "nothing was written, so nothing changed");
});

test("older cards are shown in less detail in the injected index", async () => {
  const harness = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));

  // Three cards with deliberately unrelated content and controlled ages. The dates are seeded
  // directly rather than through `task_memory_save`, which always stamps today — right for real use,
  // useless for exercising the ladder.
  const ages = [
    ["fresh-card", "rebase 冲突解决流程", "rebase", 1],
    ["old-card", "导出 PNG 透明背景处理", "png 透明", 60],
    ["ancient-card", "SSH 跳板机端口转发", "跳板机", 200],
  ];
  for (const [name, description, trigger, daysAgo] of ages) {
    const date = formatDate(Date.now() - daysAgo * 86_400_000);
    await seedCard(cwd, { name, description, triggers: [trigger], status: "verified", revision: 1, created: date, updated: date, body: "## 做法\n\n内容。" });
  }

  apply(harness.ctx, { tierDays: { past: 7, old: 30, ancient: 90, forgotten: 365 } });
  const agentSections = await emitAgentCreated(harness, cwd);
  const index = agentSections.at(-1)?.text?.() ?? "";

  assert.match(index, /\*\*近期\*\*/, "the index must group by tier");
  assert.match(index, /\*\*很久之前\*\*/);
  assert.match(index, /\*\*远古\*\*/);
  assert.match(index, /触发：rebase/, "a recent card keeps its full routing line");
  assert.doesNotMatch(index, /导出 PNG 透明背景处理；触发/, "an old card loses its trigger list");
  assert.match(index, /`ancient-card`/, "an ancient card is still listed by name");
});

test("a forgotten card drops out of the injected index and the skill catalog", async () => {
  const { ctx, tools, provider } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});

  // A published card, then aged past the forgotten boundary. Re-importing it with an old date is how
  // a card that has not been touched for a year is reproduced.
  await call(tools, "task_memory_save", { ...CARD, publish: true }, cwd);
  const old = formatDate(Date.now() - 400 * 86_400_000);
  await seedCard(cwd, { ...CARD, published: true, created: old, updated: old });

  // Still a real card: reachable through the tools, which is the promise the design makes.
  const index = await call(tools, "task_memory_index", {}, cwd);
  assert.match(index, /遗忘 1/, "the index still counts it");
  assert.match(index, /qt-tableview-flicker/);

  // But it no longer occupies the skill catalog.
  assert.deepEqual(await provider().list({ cwd }), [], "a forgotten card must not be advertised");
});

test("the dedup suggestion prefers the fresher of two equally good matches", async () => {
  const { ctx, tools } = host();
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-"));
  apply(ctx, {});

  // Two cards with the same routing text, so the score ties and recency decides.
  for (const [name, daysAgo] of [["old-rebase", 300], ["new-rebase", 1]]) {
    const date = formatDate(Date.now() - daysAgo * 86_400_000);
    await seedCard(cwd, { name, description: "rebase 冲突解决流程", triggers: ["rebase"], status: "verified", revision: 1, created: date, updated: date, body: "## 做法\n\n内容。" });
  }

  const text = await call(tools, "task_memory_save", {
    name: "another-rebase-card",
    description: "rebase 冲突解决流程",
    triggers: ["rebase"],
    body: "## 做法\n\n新结论。",
  }, cwd);

  assert.match(text, /没有创建新卡/);
  assert.match(text, /new-rebase/, "the fresher card is the one worth updating");
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
  assert.equal((await listCards(resolveStore(cwd))).length, 1, "a refused duplicate must not create a row");
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
  assert.equal((await listCards(resolveStore(cwd))).length, 2);
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
  assert.equal((await listCards(resolveStore(cwd))).length, 2);
});

test("update folds into the named card and does not add a row", async () => {
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

  const cards = await listCards(resolveStore(cwd));
  assert.equal(cards.length, 1, "an update must not create a second card");
  assert.match(cards[0].body, /## 适用场景/, "the merge must keep sections the update did not mention");
  assert.match(cards[0].body, /滚动模式/);
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
