/**
 * Integration check against the real Cordis runtime.
 *
 * The unit tests drive the plugin through a hand-written fake, which cannot prove that the real
 * loader accepts the plugin's shapes: `inject`, `ctx.inject(["webServer"], …)`, `ctx.effect`, tool
 * registration, skill-provider registration, and the prompt section. This script boots a real
 * Cordis app with minimal stand-in services and asserts the plugin actually wires itself up.
 *
 * It cannot run from this directory. The plugin is installed by junction, so a module loaded from
 * `D:\AI\dsh-task-memory` resolves `@deepseek-ai/*` against that real path — where the host packages
 * do not exist — and fails with ERR_MODULE_NOT_FOUND. Copy it into the profile's `node_modules` and
 * run it there:
 *
 *   Copy-Item test\integration.cordis.mjs "$env:DSH_PROFILE_DIR\node_modules\" -Force
 *   node "$env:DSH_PROFILE_DIR\node_modules\integration.cordis.mjs"
 *
 * Verified: every check passes (registration, behavior through the real registry, turn-end capture
 * through the real event dispatcher, disposal).
 */

import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, inject, name } from "dsh-task-memory";

const failures = [];
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
    failures.push(label);
  }
};

const app = new Context();
const tools = new Map();
const prompts = [];
const skills = {
  providers: [],
  // Record invalidations: this is the call that tells the registry its catalog changed, and a
  // missed call means a publish never reaches the Skill Center.
  invalidations: 0,
  registerProvider(create) {
    const controller = new AbortController();
    const provider = create({
      signal: controller.signal,
      invalidate() { skills.invalidations += 1; },
    });
    skills.providers.push(provider);
    return () => {
      controller.abort();
      skills.providers = skills.providers.filter((item) => item !== provider);
    };
  },
};
const routes = new Map();

app.provide("tools", { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } });
app.provide("skills", skills);
app.provide("systemPrompt", { section: (section) => { prompts.push(section); return () => {}; }, getSectionOrder: () => 2300 });
app.provide("webServer", { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } });
app.provide("workspaceRegistry", { list: () => [] });

console.log(`plugin: ${name}, inject: ${JSON.stringify(inject)}`);

// Record the plugin's event registrations, so the turn-end capture hook can be exercised against
// the real Cordis event registry rather than only through the unit-test fake.
const registered = new Map();
const originalOn = app.on.bind(app);
app.on = (event, handler) => {
  const list = registered.get(event) ?? [];
  list.push(handler);
  registered.set(event, list);
  return originalOn(event, handler);
};

// Mount the plugin exactly as the loader does.
const fiber = app.plugin({ name, apply, inject }, {});
await fiber;

console.log("\nregistrations:");
check("five tools registered", tools.size === 5, `got ${tools.size}: ${[...tools.keys()].join(",")}`);
check("one skill provider registered", skills.providers.length === 1);
check("one prompt section registered", prompts.length === 1);
check("twelve panel routes registered", routes.size === 12, `got ${routes.size}`);
check("turn-stopping listener registered", (registered.get("agent/turn-stopping") ?? []).length >= 1);
check("agent/created listener registered", (registered.get("agent/created") ?? []).length >= 1);

// Point the database at a throwaway file so this run cannot touch the real memory store.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "task-memory-cordis-home-"));

const cwd = await mkdtemp(join(tmpdir(), "task-memory-cordis-"));
const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };

console.log("\nbehavior through the real registry:");
const save = tools.get("task_memory_save");
const saved = await save.execute({ name: "cordis-card", description: "真实运行时卡片", body: "## 做法\n\n在真实 Cordis 下写入。", triggers: ["真实运行时"] }, exec);
check("save creates a card", /已创建记忆卡/.test(saved.text), saved.text.split("\n")[0]);
check("the card is readable back through the registry",
  /在真实 Cordis 下写入/.test((await tools.get("task_memory_load").execute({ name: "cordis-card" }, exec)).text));
check("save reports the card is not published", /未上架/.test(saved.text));

// The card must NOT reach the harness skill catalog: that catalog feeds the Skill Center page,
// which lists human-curated skills, not this plugin's internal memory.
const unpublished = await skills.providers[0].list({ cwd });
check("an unpublished card stays out of the skill catalog", unpublished.length === 0, `got ${unpublished.length}`);

// Publishing the same card is opt-in, and then it does appear as one catalog line with no body.
await save.execute({ name: "cordis-card", mode: "update", description: "真实运行时卡片", body: "## 做法\n\n在真实 Cordis 下写入。", triggers: ["真实运行时"], publish: true }, exec);
const candidates = await skills.providers[0].list({ cwd });
check("provider lists a published card as one catalog line", candidates.length === 1 && !("content" in candidates[0]));

const loaded = await skills.providers[0].get(candidates[0], { cwd });
check("provider loads the card body on demand", loaded?.content?.includes("真实 Cordis") === true);

const index = await tools.get("task_memory_index").execute({}, exec);
check("index tool reads the card back", /cordis-card/.test(index.text));

// The panel route must answer the shared envelope.
const handler = routes.get("/api/task-memory/cards")?.handler;
const captured = [];
const res = { writeHead: (status) => captured.push(status), end: (body) => captured.push(JSON.parse(body)) };
await handler({ url: `/api/task-memory/cards?workspace=${encodeURIComponent(cwd)}`, method: "GET", async* [Symbol.asyncIterator]() {} }, res);
check("panel route answers ok:true", captured[1]?.ok === true, JSON.stringify(captured[1]).slice(0, 120));
check("panel route returns the card", captured[1]?.cards?.[0]?.name === "cordis-card");
check("panel route reports the published flag", captured[1]?.cards?.[0]?.published === true);

// A write must invalidate the skill catalog. `control.invalidate()` bumps the registry revision,
// which is part of the registry's cache key, so the next snapshot re-reads this provider instead of
// serving the previous set — that is what makes a publish take effect without a restart.
const beforeSecondSave = skills.invalidations;
await save.execute({
  name: "cat-card", description: "rebase 冲突解决流程", triggers: ["rebase"],
  body: "## 做法\n\n先列冲突文件。", publish: true,
}, exec);
check("saving invalidates the skill catalog", skills.invalidations > beforeSecondSave,
  `${skills.invalidations} vs ${beforeSecondSave}`);

console.log("\nturn-end capture through the real dispatcher:");
// Drive the registered listener the way the harness does at a turn's stop boundary.
const steered = [];
const sessionEvents = [
  { type: "turn/start", data: { turn: 1 } },
  { type: "tool/result", data: { turn: 1, step: 1, message: { name: "read" } } },
  { type: "tool/result", data: { turn: 1, step: 1, message: { name: "grep" } } },
  { type: "tool/result", data: { turn: 1, step: 1, message: { name: "edit" } } },
];
const fakeAgent = {
  session: { snapshotEvents: () => sessionEvents },
  steer: (message) => steered.push(message),
};
for (const listener of registered.get("agent/turn-stopping") ?? []) {
  await listener({ agent: fakeAgent, turn: 1, signal: new AbortController().signal });
}
check("a substantial turn steers the review question", steered.length === 1, `got ${steered.length}`);
check("the reminder is a well-formed user message", steered[0]?.role === "user" && steered[0]?.content?.[0]?.type === "text");

// Answering is a turn of its own; it must not be reminded again.
sessionEvents.push({ type: "turn/end", data: { turn: 1 } });
sessionEvents.push({ type: "turn/start", data: { turn: 2 } });
sessionEvents.push({ type: "user/message", data: { ...steered[0] } });
for (const listener of registered.get("agent/turn-stopping") ?? []) {
  await listener({ agent: fakeAgent, turn: 2, signal: new AbortController().signal });
}
check("the review turn does not loop", steered.length === 1, `got ${steered.length}`);

console.log("\ndisposal:");
await fiber.dispose();
check("tools removed on dispose", tools.size === 0, `got ${tools.size}`);
check("provider removed on dispose", skills.providers.length === 0);
check("panel routes removed on dispose", routes.size === 0, `got ${routes.size}`);

console.log(failures.length === 0 ? "\nALL PASS" : `\nFAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
