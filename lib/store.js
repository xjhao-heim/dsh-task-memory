/**
 * Card store, backed by SQLite.
 *
 * The public API is the same as the previous file-backed implementation on purpose: the tools, the
 * skill provider, the panel, and the tier logic all describe cards, not storage, so switching the
 * backing store must not change any of their contracts. What changed is where a card lives.
 *
 * Two properties the file version had to construct by hand and the database now supplies directly:
 *
 *   - **Atomicity.** A card and its assets are written in one transaction, so a crash cannot leave
 *     assets for a card that does not exist.
 *   - **One identity.** The card's name is a primary key column, so "one task keeps one card" is a
 *     schema guarantee rather than a convention the code has to keep re-checking.
 *
 * `node:sqlite` is synchronous. That is why every function here stays `async` without awaiting
 * anything: the signatures are unchanged for callers, and the write queue in `db.js` is what keeps
 * concurrent callers from interleaving their read-modify-write cycles.
 *
 * @module dsh-task-memory/store
 */

import { resolve } from "node:path";
import { isAbsolute } from "node:path";
import { closeSharedDatabase, sharedDatabase, transact, withDatabase } from "./db.js";

/** Card lifecycle states. */
export const STATUSES = ["verified", "draft", "stale"];

/** The public skill-name grammar, which card names must satisfy. */
const CARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest accepted card name, mirroring the skill registry's practical bound. */
const MAX_NAME_LENGTH = 64;

/** Today's date in the local calendar, which is the unit a human reads on a card. */
export function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Assert that a value is a usable card name.
 * @param name - candidate name.
 * @returns the name.
 * @throws {Error} when the name is not kebab-case or is too long.
 */
export function assertCardName(name) {
  if (typeof name !== "string" || name.length === 0) throw new Error("card name is required");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`card name is longer than ${MAX_NAME_LENGTH} characters`);
  if (!CARD_NAME.test(name)) {
    throw new Error(`card name "${name}" must be kebab-case (lowercase letters, digits, single dashes)`);
  }
  return name;
}

/**
 * Resolve the store handle for one workspace.
 *
 * The database is shared across workspaces, so this returns the workspace key alongside the
 * connection: every query is scoped by that key, and that scoping is what replaces the previous
 * per-directory layout.
 *
 * @param cwd - absolute session working directory.
 * @param options - optional connection override, used by tests to keep their data isolated.
 * @returns the store handle.
 * @throws {Error} when no absolute cwd is available.
 */
export function resolveStore(cwd, options = {}) {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    throw new Error("task memory needs an absolute session working directory");
  }
  const workspace = resolve(cwd);
  const db = options.db ?? sharedDatabase(options.dbPath);
  return { workspace, db };
}

/**
 * Read a TEXT column that holds a JSON array.
 * @param value - stored text.
 * @returns the decoded list, or an empty list when the column is unusable.
 */
function decodeList(value) {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** One card as read from the database, with its derived catalog fields. */
export class Card {
  /**
   * @param options - card data.
   */
  constructor(options) {
    this.name = options.name;
    this.description = options.description;
    this.whenToUse = options.whenToUse;
    this.triggers = options.triggers;
    this.tags = options.tags;
    this.status = options.status;
    this.published = options.published === true;
    this.revision = options.revision;
    this.created = options.created;
    this.updated = options.updated;
    this.body = options.body;
  }

  /** The model-facing routing line: the description plus the trigger words that select it. */
  catalogDescription() {
    const triggers = this.triggers.length > 0 ? `；触发：${this.triggers.join("、")}` : "";
    const stale = this.status === "stale" ? "（可能已过时）" : "";
    return `${this.description}${triggers}${stale}`;
  }
}

/**
 * Turn one database row into a card.
 * @param row - a `cards` row.
 * @returns the card.
 */
function cardFromRow(row) {
  return new Card({
    name: row.name,
    description: typeof row.description === "string" && row.description.trim() !== "" ? row.description.trim() : row.name,
    whenToUse: typeof row.when_to_use === "string" && row.when_to_use.trim() !== "" ? row.when_to_use.trim() : undefined,
    triggers: decodeList(row.triggers),
    tags: decodeList(row.tags),
    status: STATUSES.includes(row.status) ? row.status : "verified",
    published: row.published === 1,
    revision: Number.isInteger(row.revision) && row.revision > 0 ? row.revision : 1,
    created: typeof row.created === "string" ? row.created : "",
    updated: typeof row.updated === "string" ? row.updated : "",
    body: typeof row.body === "string" ? row.body : "",
  });
}

/**
 * List every card in one workspace, newest first.
 *
 * Ordering happens in SQL because the tier logic needs the whole set anyway and the database can
 * sort by the same key the store already maintains an index on.
 *
 * @param store - resolved store handle.
 * @returns the cards.
 */
export async function listCards(store) {
  return await withDatabase(store.db, () => {
    const rows = store.db
      .prepare("SELECT * FROM cards WHERE workspace = ? ORDER BY updated DESC, name ASC")
      .all(store.workspace);
    return rows.map(cardFromRow);
  });
}

/**
 * Read one card by name.
 * @param store - resolved store handle.
 * @param name - card name.
 * @returns the card, or undefined when it does not exist.
 */
export async function getCard(store, name) {
  assertCardName(name);
  return await withDatabase(store.db, () => {
    const row = store.db
      .prepare("SELECT * FROM cards WHERE workspace = ? AND name = ?")
      .get(store.workspace, name);
    return row === undefined ? undefined : cardFromRow(row);
  });
}

/**
 * List the asset paths stored beside one card.
 *
 * Assets live in the database, so this is a query rather than a directory walk; the path shape is
 * unchanged (`patch/fix.diff`), which keeps the card body's relative references meaningful.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 * @returns relative asset paths, sorted.
 */
export async function listAssets(store, name) {
  assertCardName(name);
  return await withDatabase(store.db, () => store.db
    .prepare("SELECT path FROM assets WHERE workspace = ? AND card = ? ORDER BY path")
    .all(store.workspace, name)
    .map((row) => row.path));
}

/**
 * Read one asset.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 * @param path - asset path as listed.
 * @returns the bytes, or undefined when the asset does not exist.
 */
export async function readAsset(store, name, path) {
  assertCardName(name);
  if (typeof path !== "string" || path.trim() === "") return undefined;
  return await withDatabase(store.db, () => {
    const row = store.db
      .prepare("SELECT bytes FROM assets WHERE workspace = ? AND card = ? AND path = ?")
      .get(store.workspace, name, path);
    if (row === undefined) return undefined;
    // The driver hands back a Uint8Array; normalize so callers do not depend on that detail.
    return row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes ?? []);
  });
}

/**
 * Write one asset, replacing any previous content at the same path.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 * @param path - asset path.
 * @param bytes - content.
 */
export async function writeAsset(store, name, path, bytes) {
  assertCardName(name);
  if (typeof path !== "string" || path.trim() === "") throw new Error("asset path is required");
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await withDatabase(store.db, () => {
    // The card must exist first: the foreign key is what guarantees an asset never outlives its card.
    if (store.db.prepare("SELECT 1 FROM cards WHERE workspace = ? AND name = ?").get(store.workspace, name) === undefined) {
      throw new Error(`card "${name}" does not exist, so it cannot hold assets`);
    }
    store.db.prepare(
      "INSERT INTO assets (workspace, card, path, bytes) VALUES (?, ?, ?, ?) "
        + "ON CONFLICT(workspace, card, path) DO UPDATE SET bytes = excluded.bytes",
    ).run(store.workspace, name, path, data);
  });
}

/**
 * Remove one asset.
 * @param store - resolved store handle.
 * @param name - card name.
 * @param path - asset path.
 * @returns whether an asset was removed.
 */
export async function deleteAsset(store, name, path) {
  assertCardName(name);
  return await withDatabase(store.db, () => {
    const result = store.db
      .prepare("DELETE FROM assets WHERE workspace = ? AND card = ? AND path = ?")
      .run(store.workspace, name, path);
    return Number(result.changes) > 0;
  });
}

/**
 * Read load counts and last-retrieval dates.
 *
 * These used to live in a sidecar file beside the cards; they are columns now, so a card and its
 * usage history can no longer drift apart.
 *
 * @param store - resolved store handle.
 * @returns load counts and last-retrieval dates per card.
 */
export async function readStats(store) {
  return await withDatabase(store.db, () => {
    const hits = new Map();
    const lastUsed = new Map();
    for (const row of store.db
      .prepare("SELECT name, hits, last_used FROM cards WHERE workspace = ?")
      .all(store.workspace)) {
      hits.set(row.name, Number.isInteger(row.hits) && row.hits >= 0 ? row.hits : 0);
      if (typeof row.last_used === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.last_used)) {
        lastUsed.set(row.name, row.last_used);
      }
    }
    return { hits, lastUsed };
  });
}

/**
 * Read only the load counts, for callers that do not need retrieval dates.
 * @param store - resolved store handle.
 * @returns a map of card name to load count.
 */
export async function readHits(store) {
  return (await readStats(store)).hits;
}

/**
 * Record one card load, and when it happened.
 *
 * A single UPDATE, so there is no read-modify-write to interleave: the counter and the retrieval date
 * move together or not at all.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 */
export async function recordHit(store, name) {
  try {
    assertCardName(name);
    await withDatabase(store.db, () => {
      store.db.prepare(
        "UPDATE cards SET hits = hits + 1, last_used = ? WHERE workspace = ? AND name = ?",
      ).run(today(), store.workspace, name);
    });
  } catch {
    // Counters are advisory; never surface a failure to the caller that is waiting on a card.
  }
}

/** Section heading that carries the compact change history inside a card body. */
const CHANGELOG_HEADING = "变更记录";

/**
 * Split a card body into its preamble and its `##` sections, preserving order.
 * @param body - card body markdown.
 * @returns the preamble and an ordered list of sections.
 */
function splitSections(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  const lines = text === "" ? [] : text.split("\n");
  const preamble = [];
  const sections = [];
  let current = undefined;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) preamble.push(line);
    else current.lines.push(line);
  }

  return {
    preamble: preamble.join("\n").trim(),
    sections: sections.map((section) => ({ title: section.title, content: section.lines.join("\n").trim() })),
  };
}

/**
 * Merge an incoming body into the stored one, section by section.
 *
 * A section the model re-describes replaces that section; a section it does not mention is kept, so
 * a later save cannot silently erase earlier knowledge. Every merge is recorded in the changelog so
 * the card carries its own history instead of needing a journal.
 *
 * @param previous - stored body.
 * @param incoming - incoming body.
 * @param options - revision number and date used for the changelog entry.
 * @returns the merged body.
 */
export function mergeBody(previous, incoming, options) {
  const before = splitSections(previous);
  const after = splitSections(incoming);

  const merged = [];
  const seen = new Set();
  const changed = [];

  for (const section of before.sections) {
    seen.add(section.title);
    const replacement = after.sections.find((candidate) => candidate.title === section.title);
    if (replacement === undefined) {
      merged.push(section);
      continue;
    }
    if (replacement.content !== section.content) changed.push(section.title);
    merged.push({ title: section.title, content: replacement.content });
  }

  for (const section of after.sections) {
    if (seen.has(section.title)) continue;
    merged.push(section);
    changed.push(section.title);
  }

  const preamble = after.preamble !== "" ? after.preamble : before.preamble;
  const realChanges = changed.filter((title) => title !== CHANGELOG_HEADING);

  const changelog = merged.find((section) => section.title === CHANGELOG_HEADING)
    ?? { title: CHANGELOG_HEADING, content: "" };

  if (realChanges.length > 0 || options.recordRevision === true) {
    const entry = realChanges.length > 0
      ? `- r${options.revision} ${options.date}：更新 ${realChanges.join("、")}`
      : `- r${options.revision} ${options.date}：确认无变化`;
    changelog.content = changelog.content === "" ? entry : `${changelog.content}\n${entry}`;
  }

  // The changelog always belongs at the end. A section added by this save is appended to `merged`
  // after the changelog already sits there, so leaving the original order would bury the history in
  // the middle of the card.
  const ordered = [
    ...merged.filter((section) => section.title !== CHANGELOG_HEADING),
    changelog,
  ];

  const parts = [];
  if (preamble !== "") parts.push(preamble);
  for (const section of ordered) {
    parts.push(`## ${section.title}\n\n${section.content}`.trimEnd());
  }
  return parts.join("\n\n").trim();
}

/**
 * Give a brand-new body the section skeleton a reader expects, without inventing content.
 * @param body - incoming body.
 * @returns the body to store.
 */
function normalizeNewBody(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (text === "") throw new Error("card body is required; a card with no content is not worth storing");
  return text;
}

/**
 * Normalize a human-authored replacement body.
 *
 * An empty body is refused for the same reason as creation: a card with no content answers nothing,
 * and silently storing one turns a mis-click into a lost memory.
 *
 * @param body - incoming body.
 * @returns the body to store.
 */
function normalizeReplacementBody(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (text === "") throw new Error("card body is required; refuse to store a card with no content");
  return text;
}

/**
 * Union two string lists, keeping the first occurrence order and dropping case duplicates.
 * @param left - existing values.
 * @param right - incoming values.
 * @returns the merged list.
 */
function union(left, right) {
  const seen = new Set();
  const merged = [];
  for (const value of [...left, ...right]) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text === "") continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(text);
  }
  return merged;
}

/**
 * Create or update one card.
 *
 * @param store - resolved store handle.
 * @param input - card name, description, routing hints, body, and write semantics.
 * @returns the stored card and what happened.
 */
export async function saveCard(store, input) {
  const name = assertCardName(input.name);
  return await withDatabase(store.db, () => {
    const existingRow = store.db
      .prepare("SELECT * FROM cards WHERE workspace = ? AND name = ?")
      .get(store.workspace, name);
    const existing = existingRow === undefined ? undefined : cardFromRow(existingRow);
    if (existing !== undefined && input.allowUpdate !== true) {
      return { outcome: "exists", card: existing };
    }

    const date = today();
    const revision = existing === undefined ? 1 : existing.revision + 1;
    // Two writers with different intent share this function. The model's `update` is a merge: it
    // describes what it learned and unmentioned sections must survive. A human editing the card in
    // the workspace panel is doing something else — the text in the editor is exactly what they
    // want — so `replaceBody` stores it verbatim instead of merging it.
    const body = existing === undefined
      ? normalizeNewBody(input.body)
      : input.replaceBody === true
        ? normalizeReplacementBody(input.body)
        : mergeBody(existing.body, input.body, { revision, date });
    const created = existing?.created !== "" && existing?.created !== undefined ? existing.created : date;

    const triggers = input.replaceFields === true ? (input.triggers ?? []) : union(existing?.triggers ?? [], input.triggers ?? []);
    const tags = input.replaceFields === true ? (input.tags ?? []) : union(existing?.tags ?? [], input.tags ?? []);
    const status = STATUSES.includes(input.status) ? input.status : (existing?.status ?? "verified");
    // Publication is sticky: once a card is deliberately offered as a skill, an ordinary update does
    // not silently withdraw it. Only an explicit publish flag changes it.
    const published = typeof input.publish === "boolean" ? input.publish : (existing?.published ?? false);
    const whenToUse = input.whenToUse !== undefined && input.whenToUse !== ""
      ? input.whenToUse
      : existing?.whenToUse;

    const row = {
      description: (input.description ?? existing?.description ?? name).trim(),
      whenToUse: whenToUse ?? null,
      triggers: JSON.stringify(triggers),
      tags: JSON.stringify(tags),
      status,
      published: published ? 1 : 0,
      revision,
      created,
      updated: date,
      body,
    };

    store.db.prepare(
      `INSERT INTO cards (workspace, name, description, when_to_use, triggers, tags, status, published, revision, created, updated, body, hits, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(workspace, name) DO UPDATE SET
         description = excluded.description,
         when_to_use = excluded.when_to_use,
         triggers    = excluded.triggers,
         tags        = excluded.tags,
         status      = excluded.status,
         published   = excluded.published,
         revision    = excluded.revision,
         created     = excluded.created,
         updated     = excluded.updated,
         body        = excluded.body`,
    ).run(
      store.workspace, name, row.description, row.whenToUse, row.triggers, row.tags,
      row.status, row.published, row.revision, row.created, row.updated, row.body,
    );

    const saved = cardFromRow(store.db.prepare("SELECT * FROM cards WHERE workspace = ? AND name = ?").get(store.workspace, name));
    return { outcome: existing === undefined ? "created" : "updated", card: saved };
  });
}

/**
 * Search card text, returning a snippet around the first hit in each card.
 *
 * @param store - resolved store handle.
 * @param query - case-insensitive substring, or a regular expression when `regex` is set.
 * @param options - regex flag, result cap, and tier boundaries for the returned classification.
 * @returns matches with their snippets.
 */
export async function searchCards(store, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const pattern = options.regex === true
    ? new RegExp(query, options.caseSensitive === true ? "" : "i")
    : undefined;
  const needle = options.caseSensitive === true ? query : query.toLowerCase();
  const stats = await readStats(store);

  const matches = [];
  for (const card of await listCards(store)) {
    const text = `${card.description}\n${card.whenToUse ?? ""}\n${card.triggers.join(" ")}\n${card.tags.join(" ")}\n${card.body}`;
    const haystack = options.caseSensitive === true || pattern !== undefined ? text : text.toLowerCase();
    const index = pattern !== undefined ? haystack.search(pattern) : haystack.indexOf(needle);
    if (index === -1) continue;
    const width = pattern !== undefined ? 0 : needle.length;
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + width + 60);
    matches.push({
      name: card.name,
      status: card.status,
      updated: card.updated,
      lastUsed: stats.lastUsed.get(card.name),
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * Import one card verbatim, bypassing the create/update semantics.
 *
 * A legacy import must reproduce what was stored, including the original dates and revision, rather
 * than re-deriving them the way a fresh save would.
 *
 * @param store - resolved store handle.
 * @param input - complete card fields.
 * @returns the stored card.
 */
export async function importCard(store, input) {
  const name = assertCardName(input.name);
  return await withDatabase(store.db, () => {
    store.db.prepare(
      `INSERT INTO cards (workspace, name, description, when_to_use, triggers, tags, status, published, revision, created, updated, body, hits, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace, name) DO UPDATE SET
         description = excluded.description,
         when_to_use = excluded.when_to_use,
         triggers    = excluded.triggers,
         tags        = excluded.tags,
         status      = excluded.status,
         published   = excluded.published,
         revision    = excluded.revision,
         created     = excluded.created,
         updated     = excluded.updated,
         body        = excluded.body,
         hits        = excluded.hits,
         last_used   = excluded.last_used`,
    ).run(
      store.workspace, name,
      String(input.description ?? name),
      input.whenToUse ?? null,
      JSON.stringify(Array.isArray(input.triggers) ? input.triggers : []),
      JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
      STATUSES.includes(input.status) ? input.status : "verified",
      input.published === true ? 1 : 0,
      Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
      String(input.created ?? ""),
      String(input.updated ?? ""),
      String(input.body ?? ""),
      Number.isInteger(input.hits) && input.hits >= 0 ? input.hits : 0,
      typeof input.lastUsed === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.lastUsed) ? input.lastUsed : null,
    );
    return cardFromRow(store.db.prepare("SELECT * FROM cards WHERE workspace = ? AND name = ?").get(store.workspace, name));
  });
}

/**
 * Delete one card and everything attached to it.
 *
 * The assets go with it through the foreign key's cascade, so a card can never leave orphans behind.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 * @returns whether a card was removed.
 */
export async function deleteCard(store, name) {
  assertCardName(name);
  return await withDatabase(store.db, () => {
    const result = store.db
      .prepare("DELETE FROM cards WHERE workspace = ? AND name = ?")
      .run(store.workspace, name);
    return Number(result.changes) > 0;
  });
}

/**
 * Count the cards in one workspace.
 * @param store - resolved store handle.
 * @returns the card count.
 */
export async function countCards(store) {
  return await withDatabase(store.db, () => Number(
    store.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE workspace = ?").get(store.workspace).n,
  ));
}

/** Exported for teardown and tests: close the shared connection. */
export { closeSharedDatabase, transact };
