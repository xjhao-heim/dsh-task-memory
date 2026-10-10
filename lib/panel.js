/**
 * Workspace panel HTTP API.
 *
 * The panel is a browser view, so it needs a data path from the Host. This module owns that path:
 * five `/api/task-memory/*` routes registered on `ctx.webServer`, answering JSON.
 *
 * Why plain routes rather than a generated Remote namespace: the panel is the only Client consumer,
 * its shapes are small and hand-checked here, and a Typert Remote would need generated artifacts
 * this plugin has no build step to produce. Plain routes keep the plugin installable from a source
 * directory with no compilation, which is the same constraint that shapes the rest of this package.
 *
 * Every route answers the same envelope: `{ ok: true, ... }` or `{ ok: false, error }` with a
 * non-2xx status, so the Client has exactly one failure shape to render.
 *
 * @module dsh-task-memory/panel
 */

import { resolve } from "node:path";
import { isAbsolute } from "node:path";
import {
  deleteCard,
  getCard,
  listAssets,
  listCards,
  readStats,
  resolveStore,
  saveCard,
  searchCards,
  STATUSES,
} from "./store.js";
import { ageLabel, formatDate, resolveDefaultTiers, resolveTierDays, TIER_LABELS, TIER_ORDER, tierOf } from "./tiers.js";
import { importLegacy, previewLegacy, removeLegacy, scanLegacy } from "./legacy.js";

/**
 * Parse the `tiers` query parameter.
 *
 * Returns `undefined` for "no tier filter", which is distinct from an empty set: the panel sends an
 * empty value when the filter has not been resolved yet, and treating that as "match nothing" would
 * make the list look empty on first paint.
 *
 * @param raw - comma-separated tier ids, or null.
 * @returns the accepted tiers, or undefined when unrestricted.
 */
function parseTierFilter(raw) {
  if (raw === null || raw.trim() === "") return undefined;
  const wanted = raw.split(",").map((item) => item.trim()).filter((item) => TIER_ORDER.includes(item));
  return wanted.length === 0 ? undefined : new Set(wanted);
}

/** Longest request body accepted by a mutating route, in bytes. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Send a JSON response.
 * @param res - server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 *
 * The cap is enforced while reading rather than trusted from `content-length`: a declared length is
 * the client's claim, and this route is reachable from the page.
 *
 * @param req - incoming request.
 * @returns the parsed body.
 * @throws {Error} when the body is oversized or not valid JSON.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/**
 * Resolve the workspace a request targets.
 *
 * The panel lists cards for one workspace. A request must name that workspace explicitly: the panel
 * is global UI, and defaulting to "some" workspace would silently show one project's memory while
 * the user believes they are looking at another's.
 *
 * @param path - candidate workspace path from the query string or body.
 * @returns the resolved store paths.
 * @throws {Error} when no usable absolute path was supplied.
 */
function storeFor(path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("a workspace path is required");
  }
  if (!isAbsolute(path)) throw new Error("the workspace path must be absolute");
  return resolveStore(resolve(path));
}

/**
 * Serialize one card for the panel list.
 * @param card - stored card.
 * @param hits - recorded load count.
 * @returns the JSON row.
 */
function cardRow(card, hits, classification) {
  const tier = classification?.tier ?? "recent";
  const days = classification?.days ?? 0;
  return {
    name: card.name,
    description: card.description,
    whenToUse: card.whenToUse ?? null,
    triggers: card.triggers,
    tags: card.tags,
    status: card.status,
    published: card.published === true,
    revision: card.revision,
    created: card.created,
    updated: card.updated,
    hits,
    // The tier is computed on every read, never stored, so it cannot go stale.
    tier,
    tierLabel: TIER_LABELS[tier],
    ageLabel: ageLabel(days),
    days: Number.isFinite(days) ? days : null,
  };
}

/**
 * Build one route handler that answers the shared envelope.
 *
 * @param handler - receives the parsed request and returns a payload to merge into the envelope.
 * @returns a webServer route handler.
 */
function route(handler) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const payload = await handler({ req, url, body });
      sendJson(res, 200, { ok: true, ...payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed mutation must not read as a success with an empty list; the status carries that.
      sendJson(res, 400, { ok: false, error: message });
    }
  };
}

/**
 * Register the panel routes.
 *
 * @param ctx - plugin context carrying `webServer` once that service exists.
 * @param logger - logger used when the service is unavailable.
 * @param afterWrite - called after a card is created, edited, or deleted, so the injected index and
 *   the skill catalog both stop serving the previous state. The panel is the only writer that does
 *   not go through a tool, so without this a publish made in the UI would not take effect.
 * @param rawDays - configured tier boundaries; the panel shows the same tiers the model sees.
 * @param rawDefaultTiers - which tiers the panel opens on. "Default shows the recent tier" is a
 *   policy the user can change, so it travels from configuration rather than being hard-coded in the
 *   browser.
 * @param settings - live settings access: `snapshot()`, `update(patch)`, and the file `path`. The
 *   section reads effective values and writes through this one handle, so the settings page and the
 *   plugin never disagree about what is configured.
 * @returns a disposer removing every route, or undefined when there is no web server.
 */
export function registerPanelRoutes(ctx, logger, afterWrite, rawDays, rawDefaultTiers, settings) {
  const days = resolveTierDays(rawDays);
  const defaultTiers = resolveDefaultTiers(rawDefaultTiers);
  const webServer = ctx.get("webServer");
  if (webServer === undefined || typeof webServer.register !== "function") {
    // A headless or non-web profile has no browser panel and must still mount every other feature.
    logger?.info?.("dsh-task-memory: no webServer in this profile; the memory panel is unavailable");
    return undefined;
  }

  const notify = (workspace) => {
    if (typeof afterWrite !== "function") return;
    void Promise.resolve(afterWrite(workspace)).catch(() => {});
  };

  const disposers = [];

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/workspaces",
    handler: route(async () => {
      // The registry is optional: without it the panel still works for a workspace the user pastes
      // in, and a profile that has it simply gets a picker.
      const registry = ctx.get("workspaceRegistry");
      const workspaces = [];
      if (registry !== undefined && typeof registry.list === "function") {
        for (const workspace of registry.list()) {
          const store = resolveStore(workspace.path);
          let count = 0;
          try {
            count = (await listCards(store)).length;
          } catch {
            count = 0;
          }
          workspaces.push({ id: String(workspace.id), path: workspace.path, title: workspace.title, cards: count });
        }
      }
      return { workspaces };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/cards",
    handler: route(async ({ url }) => {
      const store = storeFor(url.searchParams.get("workspace"));
      const [cards, stats] = await Promise.all([listCards(store), readStats(store)]);

      // Classify once; the filter, the sort, the date bounds and the day strip all read this.
      const rows = cards.map((card) => ({
        card,
        hits: stats.hits.get(card.name) ?? 0,
        classification: tierOf(card, { lastUsed: stats.lastUsed.get(card.name), days }),
      }));

      // Which days hold cards, for the picker's marks. Counted before any filter, so the marks
      // always describe the workspace rather than the current query.
      const perDay = new Map();
      for (const row of rows) {
        if (row.classification.at === undefined) continue;
        const key = formatDate(row.classification.at);
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
      }
      const dayList = [...perDay.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, count]) => ({ date, count }));
      const allDates = [...perDay.keys()].sort();

      const wanted = parseTierFilter(url.searchParams.get("tiers"));
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";

      const filtered = rows.filter((row) => {
        if (wanted !== undefined && !wanted.has(row.classification.tier)) return false;
        // A card with no usable date cannot satisfy a range: it is excluded rather than guessed into
        // one, the same way it is classified as forgotten rather than recent.
        if (from === "" && to === "") return true;
        if (row.classification.at === undefined) return false;
        const day = formatDate(row.classification.at);
        if (from !== "" && day < from) return false;
        if (to !== "" && day > to) return false;
        return true;
      });

      const sorted = filtered
        .sort((a, b) => {
          const order = TIER_ORDER.indexOf(a.classification.tier) - TIER_ORDER.indexOf(b.classification.tier);
          if (order !== 0) return order;
          return String(b.card.updated).localeCompare(String(a.card.updated)) || a.card.name.localeCompare(b.card.name);
        })
        .map(({ card, hits, classification }) => cardRow(card, hits, classification));

      return {
        workspace: store.workspace,
        cards: sorted,
        total: rows.length,
        shown: sorted.length,
        tierDays: days,
        // The panel must not re-derive what "default" means, nor which days hold data.
        defaultTiers,
        dateBounds: { min: allDates[0] ?? "", max: allDates.at(-1) ?? "" },
        days: dayList,
      };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/card",
    handler: route(async ({ url }) => {
      const store = storeFor(url.searchParams.get("workspace"));
      const name = url.searchParams.get("name");
      if (name === null || name === "") throw new Error("a card name is required");
      const card = await getCard(store, name);
      if (card === undefined) throw new Error(`没有名为 ${name} 的记忆卡`);
      const stats = await readStats(store);
      return {
        card: cardRow(card, stats.hits.get(card.name) ?? 0,
          tierOf(card, { lastUsed: stats.lastUsed.get(card.name), days })),
        body: card.body,
        assets: await listAssets(store, card.name),
      };
    }),
  }));

  // Legacy import: preview, then import, then optionally delete the source.
  //
  // Three routes rather than one because the steps have different risk: previewing touches nothing,
  // importing writes, and deleting the source files is irreversible. Splitting them is what lets the
  // panel show the user exactly what will happen before each step.
  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/legacy/preview",
    handler: route(async ({ url }) => {
      const store = storeFor(url.searchParams.get("workspace"));
      const scan = await scanLegacy(store.workspace);
      const preview = await previewLegacy(store, scan);
      // The card list can be long; the panel only needs the summary plus enough detail to recognise
      // which knowledge is about to move.
      return { ...preview, cards: preview.cards.slice(0, 200) };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/legacy/import",
    handler: route(async ({ body }) => {
      const store = storeFor(body.workspace);
      const scan = await scanLegacy(store.workspace);
      if (!scan.found) throw new Error("这个工作区没有旧版记忆文件");
      const result = await importLegacy(store, scan, { overwrite: body.overwrite === true });
      if (result.imported.length > 0) notify(store.workspace);
      return {
        ...result,
        // The paths the caller may delete next, so the confirmation can name them precisely instead
        // of describing "the old files" in the abstract.
        sources: [scan.paths.notes, scan.paths.stats],
      };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/legacy/remove",
    handler: route(async ({ body }) => {
      const store = storeFor(body.workspace);
      const scan = await scanLegacy(store.workspace);
      // `removeLegacy` already returns `{ removed: [...] }`; spreading it keeps the response flat.
      // Returning `{ removed }` would nest the list under `removed.removed`, which is exactly the
      // shape a caller cannot guess.
      return { ...(await removeLegacy(scan)) };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/save",
    handler: route(async ({ body }) => {
      const store = storeFor(body.workspace);
      const mode = body.mode === "update" ? "update" : "create";
      if (typeof body.name !== "string" || body.name.trim() === "") throw new Error("卡片名字不能为空");
      if (typeof body.description !== "string" || body.description.trim() === "") throw new Error("卡片描述不能为空");
      if (typeof body.body !== "string" || body.body.trim() === "") throw new Error("卡片正文不能为空");

      const existing = await getCard(store, body.name);
      if (mode === "create" && existing !== undefined) {
        throw new Error(`记忆卡 ${body.name} 已存在；改用它来保存，或换一个名字`);
      }
      if (mode === "update" && existing === undefined) {
        throw new Error(`没有名为 ${body.name} 的记忆卡`);
      }

      // A human's edit is authoritative: store the text verbatim instead of merging it the way the
      // model's `update` does, and replace the routing fields instead of unioning them (otherwise a
      // trigger the user just removed would come straight back).
      const saved = await saveCard(store, {
        name: body.name,
        description: body.description,
        whenToUse: typeof body.whenToUse === "string" ? body.whenToUse : undefined,
        triggers: Array.isArray(body.triggers) ? body.triggers : [],
        tags: Array.isArray(body.tags) ? body.tags : [],
        status: STATUSES.includes(body.status) ? body.status : undefined,
        ...(typeof body.published === "boolean" ? { publish: body.published } : {}),
        body: body.body,
        allowUpdate: true,
        replaceBody: true,
        replaceFields: true,
      });
      notify(store.workspace);
      return { card: cardRow(saved.card, 0), outcome: saved.outcome };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/delete",
    handler: route(async ({ body }) => {
      const store = storeFor(body.workspace);
      if (typeof body.name !== "string" || body.name.trim() === "") throw new Error("卡片名字不能为空");
      const removed = await deleteCard(store, body.name);
      if (!removed) throw new Error(`没有名为 ${body.name} 的记忆卡`);
      notify(store.workspace);
      return { removed: body.name };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/search",
    handler: route(async ({ url }) => {
      const store = storeFor(url.searchParams.get("workspace"));
      const query = url.searchParams.get("q") ?? "";
      if (query === "") return { matches: [] };
      return { matches: await searchCards(store, query, { limit: 50, days }) };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/settings",
    handler: route(async ({ req, body }) => {
      if (req.method !== "POST") {
        // Reading the settings also materializes them: the page shows every parameter with its
        // effective value, so a parameter the local file does not carry yet is written with the
        // default the plugin actually uses. Otherwise the page would show a value that exists only
        // in memory, and the file would stay an incomplete description of the configuration.
        const initialized = await settings.ensureDefaults();
        return {
          settings: settings.snapshot(),
          effective: settings.effectiveView(),
          configPath: settings.path,
          initialized,
        };
      }
      const saved = await settings.update(body);
      return {
        settings: settings.snapshot(),
        effective: settings.effectiveView(),
        configPath: settings.path,
        message: saved.reset === true ? "已恢复默认。" : "已保存，立即生效。",
      };
    }),
  }));

  // Manual cleanup of forgotten cards.
  //
  // Deliberately not automatic: this plugin's whole promise is that a memory does not silently
  // disappear, so the only thing an age threshold may do on its own is stop advertising a card.
  // Deleting needs a human naming the card, and the answer says exactly what went.
  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/forgotten",
    handler: route(async ({ url }) => {
      const store = storeFor(url.searchParams.get("workspace"));
      const [cards, stats] = await Promise.all([listCards(store), readStats(store)]);
      const rows = cards
        .map((card) => ({
          card,
          classification: tierOf(card, { lastUsed: stats.lastUsed.get(card.name), days }),
        }))
        .filter((row) => row.classification.tier === "forgotten")
        .sort((a, b) => (a.classification.at ?? 0) - (b.classification.at ?? 0));
      return {
        forgotten: rows.map((row) => cardRow(row.card, stats.hits.get(row.card.name) ?? 0, row.classification)),
      };
    }),
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/api/task-memory/purge",
    handler: route(async ({ body }) => {
      const store = storeFor(body.workspace);
      const names = Array.isArray(body.names) ? body.names.filter((name) => typeof name === "string") : [];
      if (names.length === 0) throw new Error("需要给出要清理的卡片名字");
      const removed = [];
      const failed = [];
      for (const name of names) {
        try {
          if (await deleteCard(store, name)) removed.push(name);
          else failed.push(name);
        } catch (error) {
          failed.push(name);
        }
      }
      if (removed.length > 0) notify(store.workspace);
      return { removed, failed };
    }),
  }));

  logger?.info?.(`dsh-task-memory: memory panel API mounted on ${disposers.length} routes`);
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // A route already removed during teardown must not block the rest.
      }
    }
  };
}
