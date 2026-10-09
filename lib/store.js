/**
 * Workspace card store.
 *
 * One card per task, on disk, under `<cwd>/.dsh/task-memory/notes/<name>/SKILL.md`. The same file
 * is both the durable memory and the skill body, so there is exactly one copy of the truth: the
 * index is derived from these files on every read and can never drift away from them.
 *
 * Deliberately not stored:
 *   - an index file. The catalog is recomputed from card frontmatter, so a hand edit is visible
 *     immediately and a stale index is impossible.
 *   - read counters inside a card. Loads would then rewrite authored content on every read; a
 *     read-only `stats.json` holds them instead, leaving card diffs to human edits only.
 *
 * @module dsh-task-memory/store
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listField, parseCard, serializeCard } from "./frontmatter.js";

/** Directory under the session cwd that owns every artifact of this plugin. */
const STORE_DIRECTORY = ".dsh/task-memory";

/** The public skill-name grammar, which card names must satisfy. */
const CARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Card lifecycle states. */
export const STATUSES = ["verified", "draft", "stale"];

/** Longest accepted card name, mirroring the skill registry's practical bound. */
const MAX_NAME_LENGTH = 64;

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
 * Resolve the store location for one workspace and prove it stays inside it.
 *
 * Every path the store touches is derived from this root, so the containment check here is what
 * keeps a crafted card name from reaching outside the workspace.
 *
 * @param cwd - absolute session working directory.
 * @returns the resolved store paths.
 * @throws {Error} when no absolute cwd is available.
 */
export function resolveStore(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    throw new Error("task memory needs an absolute session working directory");
  }
  const workspace = resolve(cwd);
  const root = join(workspace, ...STORE_DIRECTORY.split("/"));
  const notes = join(root, "notes");
  return {
    workspace,
    root,
    notes,
    statsPath: join(root, "stats.json"),
    cardPath: (name) => {
      const path = join(notes, assertCardName(name));
      const within = relative(notes, path);
      if (within === "" || within.startsWith("..") || isAbsolute(within)) {
        throw new Error(`card path escapes the store: ${path}`);
      }
      return path;
    },
  };
}

/**
 * Read the best-effort JSON file, returning a fallback when it is absent or unreadable.
 * @param path - file path.
 * @param fallback - value to return on any failure.
 * @returns the parsed value or the fallback.
 */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Write a file atomically: a sibling temporary file then a rename, so a crash cannot leave a
 * half-written card behind.
 * @param path - destination path.
 * @param text - complete file text.
 */
async function writeAtomic(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Serialize writes per store root.
 *
 * Two concurrent `save` calls for the same card would otherwise interleave read-modify-write and
 * lose one update. The queue is keyed by root so unrelated workspaces never block each other.
 */
const writeQueues = new Map();

/**
 * Run an operation with exclusive access to one store root.
 * @param key - queue key.
 * @param operation - work to run.
 * @returns the operation's value.
 */
function withLock(key, operation) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // Keep the chain alive but never let a rejection poison the queue for later callers.
  writeQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

/** One card as read from disk, with its derived catalog fields. */
export class Card {
  /**
   * @param options - parsed card data.
   */
  constructor(options) {
    this.name = options.name;
    this.description = options.description;
    this.whenToUse = options.whenToUse;
    this.triggers = options.triggers;
    this.tags = options.tags;
    this.status = options.status;
    this.revision = options.revision;
    this.created = options.created;
    this.updated = options.updated;
    this.body = options.body;
    this.path = options.path;
    this.directory = options.directory;
    this.problem = options.problem;
  }

  /** The model-facing routing line: the description plus the trigger words that select it. */
  catalogDescription() {
    const triggers = this.triggers.length > 0 ? `；触发：${this.triggers.join("、")}` : "";
    const stale = this.status === "stale" ? "（可能已过时）" : "";
    return `${this.description}${triggers}${stale}`;
  }
}

/**
 * Build a card from file text, tolerating a hand-edited file.
 * @param name - directory name, which is authoritative for the card identity.
 * @param path - card file path.
 * @param directory - card directory.
 * @param text - file text.
 * @returns the parsed card.
 */
function cardFromText(name, path, directory, text) {
  const { fields, body } = parseCard(text);
  const described = typeof fields.description === "string" ? fields.description.trim() : "";
  return new Card({
    name,
    description: described === "" ? name : described,
    whenToUse: typeof fields.whenToUse === "string" ? fields.whenToUse.trim() : undefined,
    triggers: listField(fields, "triggers"),
    tags: listField(fields, "tags"),
    status: STATUSES.includes(fields.status) ? fields.status : "verified",
    revision: Number.isInteger(fields.revision) && fields.revision > 0 ? fields.revision : 1,
    created: typeof fields.created === "string" ? fields.created : "",
    updated: typeof fields.updated === "string" ? fields.updated : "",
    body,
    path,
    directory,
    problem: undefined,
  });
}

/**
 * List every readable card in one workspace.
 *
 * A malformed card is reported as an unreadable entry rather than dropped, so `task_memory_index`
 * can tell the model that something exists but needs repair; one bad file never hides the rest.
 *
 * @param store - resolved store paths.
 * @returns the cards, sorted by name.
 */
export async function listCards(store) {
  let entries;
  try {
    entries = await readdir(store.notes, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }

  const cards = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (!CARD_NAME.test(entry.name)) continue;
    const directory = join(store.notes, entry.name);
    const path = join(directory, "SKILL.md");
    try {
      cards.push(cardFromText(entry.name, path, directory, await readFile(path, "utf8")));
    } catch (error) {
      cards.push(new Card({
        name: entry.name,
        description: entry.name,
        whenToUse: undefined,
        triggers: [],
        tags: [],
        status: "stale",
        revision: 0,
        created: "",
        updated: "",
        body: "",
        path,
        directory,
        problem: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return cards;
}

/**
 * Read one card by name.
 * @param store - resolved store paths.
 * @param name - card name.
 * @returns the card, or undefined when it does not exist.
 */
export async function getCard(store, name) {
  assertCardName(name);
  const directory = store.cardPath(name);
  try {
    return cardFromText(name, join(directory, "SKILL.md"), directory, await readFile(join(directory, "SKILL.md"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * List the asset files stored beside one card.
 * @param card - the card.
 * @returns relative asset paths, sorted.
 */
export async function listAssets(card) {
  const assets = join(card.directory, "assets");
  const found = [];
  const walk = async (directory, prefix) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), next);
      else found.push(next);
    }
  };
  await walk(assets, "");
  return found;
}

/**
 * Read the usage counters.
 * @param store - resolved store paths.
 * @returns a map of card name to load count.
 */
export async function readStats(store) {
  const raw = await readJson(store.statsPath, {});
  const hits = raw !== null && typeof raw === "object" && raw.hits !== null && typeof raw.hits === "object"
    ? raw.hits
    : {};
  const result = new Map();
  for (const [name, value] of Object.entries(hits)) {
    if (Number.isInteger(value) && value >= 0) result.set(name, value);
  }
  return result;
}

/**
 * Record one card load.
 *
 * Best effort on purpose: a counter that cannot be written must never fail the load that the model
 * is waiting on.
 *
 * @param store - resolved store paths.
 * @param name - card name.
 */
export async function recordHit(store, name) {
  try {
    await withLock(store.statsPath, async () => {
      const stats = await readStats(store);
      stats.set(name, (stats.get(name) ?? 0) + 1);
      const hits = Object.fromEntries([...stats.entries()].sort(([a], [b]) => a.localeCompare(b)));
      await writeAtomic(store.statsPath, `${JSON.stringify({ version: 1, hits }, null, 2)}\n`);
    });
  } catch {
    // Counters are advisory; never surface a failure to the caller.
  }
}

/** Today's date in the local calendar, which is the unit a human reads on a card. */
export function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
  let preamble = [];
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
 * the card carries its own history instead of needing a journal file.
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
 * Compute the stable similarity key for a card name.
 * @param name - card name.
 * @returns a short digest.
 */
export function nameDigest(name) {
  return createHash("sha1").update(name).digest("hex").slice(0, 8);
}

/**
 * Create or update one card.
 *
 * @param store - resolved store paths.
 * @param input - card name, description, routing hints, body, and whether creation is allowed.
 * @returns the stored card and what happened.
 */
export async function saveCard(store, input) {
  const name = assertCardName(input.name);
  return await withLock(store.root, async () => {
    const existing = await getCard(store, name);
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

    const directory = store.cardPath(name);
    const path = join(directory, "SKILL.md");
    const text = serializeCard({
      name,
      description: (input.description ?? existing?.description ?? name).trim(),
      ...(input.whenToUse !== undefined && input.whenToUse !== ""
        ? { whenToUse: input.whenToUse }
        : existing?.whenToUse !== undefined ? { whenToUse: existing.whenToUse } : {}),
      triggers,
      tags,
      status,
      revision,
      created,
      updated: date,
    }, body);

    await writeAtomic(path, text);
    const card = cardFromText(name, path, directory, text);
    return { outcome: existing === undefined ? "created" : "updated", card };
  });
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
 * Search card text, returning a snippet around the first hit in each card.
 *
 * @param store - resolved store paths.
 * @param query - case-insensitive substring, or a regular expression when `regex` is set.
 * @param options - regex flag and result cap.
 * @returns matches with their snippets.
 */
export async function searchCards(store, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const pattern = options.regex === true
    ? new RegExp(query, options.caseSensitive === true ? "" : "i")
    : undefined;
  const needle = options.caseSensitive === true ? query : query.toLowerCase();

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
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * Delete one card directory.
 *
 * Not exposed as a model-facing tool on purpose: a memory the model can erase on its own is a
 * memory that disappears. It exists for the workspace panel (P3) and for tests.
 *
 * @param store - resolved store paths.
 * @param name - card name.
 * @returns whether a card was removed.
 */
export async function deleteCard(store, name) {
  assertCardName(name);
  const directory = store.cardPath(name);
  const present = await stat(directory).then(() => true, () => false);
  if (!present) return false;
  return await withLock(store.root, async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
    return true;
  });
}

/** Exported for tests: the relative store directory this plugin owns. */
export const STORE_RELATIVE_DIRECTORY = STORE_DIRECTORY.split("/").join(sep);
