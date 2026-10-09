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

import { readFile } from "node:fs/promises";
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
function cardRow(card, hits) {
  return {
    name: card.name,
    description: card.description,
    whenToUse: card.whenToUse ?? null,
    triggers: card.triggers,
    tags: card.tags,
    status: card.status,
    revision: card.revision,
    created: card.created,
    updated: card.updated,
    hits,
    problem: card.problem ?? null,
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
 * @returns a disposer removing every route, or undefined when there is no web server.
 */
export function registerPanelRoutes(ctx, logger) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined || typeof webServer.register !== "function") {
    // A headless or non-web profile has no browser panel and must still mount every other feature.
    logger?.info?.("dsh-task-memory: no webServer in this profile; the memory panel is unavailable");
    return undefined;
  }

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
      const sorted = cards
        .map((card) => cardRow(card, stats.get(card.name) ?? 0))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.name.localeCompare(b.name));
      return { workspace: store.workspace, notes: store.notes, cards: sorted };
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
      if (card.problem !== undefined) throw new Error(`卡片读取失败：${card.problem}`);
      // The raw file text is what the editor edits: returning a re-serialized body would silently
      // drop any frontmatter field this code does not model.
      let raw;
      try {
        raw = await readFile(card.path, "utf8");
      } catch {
        raw = "";
      }
      return {
        card: cardRow(card, 0),
        body: card.body,
        raw,
        assets: await listAssets(card),
        path: card.path,
      };
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
        body: body.body,
        allowUpdate: true,
        replaceBody: true,
        replaceFields: true,
      });
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
      return { matches: await searchCards(store, query, { limit: 50 }) };
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
