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
 * Verified output: 14/14 checks pass (registration, behavior through the real registry, disposal).
 */

import { Context } from "@deepseek-ai/cordis";
import { mkdtemp, readdir } from "node:fs/promises";
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
const skills = { providers: [], registerProvider(create) { const p = create({ signal: new AbortController().signal, invalidate() {} }); this.providers.push(p); return () => { this.providers = this.providers.filter((x) => x !== p); }; } };
const routes = new Map();

app.provide("tools", { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } });
app.provide("skills", skills);
app.provide("systemPrompt", { section: (section) => { prompts.push(section); return () => {}; }, getSectionOrder: () => 2300 });
app.provide("webServer", { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } });
app.provide("workspaceRegistry", { list: () => [] });

console.log(`plugin: ${name}, inject: ${JSON.stringify(inject)}`);

// Mount the plugin exactly as the loader does.
const fiber = app.plugin({ name, apply, inject }, {});
await fiber;

console.log("\nregistrations:");
check("four tools registered", tools.size === 4, `got ${tools.size}: ${[...tools.keys()].join(",")}`);
check("one skill provider registered", skills.providers.length === 1);
check("one prompt section registered", prompts.length === 1);
check("six panel routes registered", routes.size === 6, `got ${routes.size}`);

const cwd = await mkdtemp(join(tmpdir(), "task-memory-cordis-"));
const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };

console.log("\nbehavior through the real registry:");
const save = tools.get("task_memory_save");
const saved = await save.execute({ name: "cordis-card", description: "真实运行时卡片", body: "## 做法\n\n在真实 Cordis 下写入。", triggers: ["真实运行时"] }, exec);
check("save creates a card", /已创建记忆卡/.test(saved.text), saved.text.split("\n")[0]);
check("card file exists on disk", (await readdir(join(cwd, ".dsh", "task-memory", "notes"))).includes("cordis-card"));

const candidates = await skills.providers[0].list({ cwd });
check("provider lists the card as one catalog line", candidates.length === 1 && !("content" in candidates[0]));

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

console.log("\ndisposal:");
await fiber.dispose();
check("tools removed on dispose", tools.size === 0, `got ${tools.size}`);
check("provider removed on dispose", skills.providers.length === 0);
check("panel routes removed on dispose", routes.size === 0, `got ${routes.size}`);

console.log(failures.length === 0 ? "\nALL PASS" : `\nFAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
