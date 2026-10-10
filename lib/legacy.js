/**
 * Legacy import: the file-backed store into the database.
 *
 * Before this plugin used SQLite, a card was a directory of `SKILL.md` plus a `stats.json` beside
 * it. Those files are still on disk for any workspace that was used earlier, and they hold real
 * knowledge, so the import is a first-class operation rather than a migration script a user runs
 * once and hopes worked.
 *
 * Three properties matter more than speed here:
 *
 *   1. **Preview before write.** `scanLegacy` reads and parses without touching anything, so the UI
 *      can say exactly what will be imported — and nothing happens until a human confirms.
 *   2. **Idempotent.** Importing twice must not duplicate or downgrade a card. An existing card is
 *      reported as a conflict, and the caller decides whether to overwrite.
 *   3. **Deletion is the caller's act.** The importer never removes a source file. It reports the
 *      paths it read; deleting them is a separate, explicit request.
 *
 * @module dsh-task-memory/legacy
 */

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { listField, parseCard } from "./frontmatter.js";
import { assertCardName, getCard, importCard, listCards, writeAsset } from "./store.js";

/** Directory the plugin used to own inside a workspace. */
const LEGACY_DIRECTORY = ".dsh/task-memory";

/** Card file name inside a legacy card directory. */
const CARD_FILE = "SKILL.md";

/** Attachment directory inside a legacy card directory. */
const ASSET_DIRECTORY = "assets";

/**
 * Resolve the legacy layout for one workspace.
 *
 * @param cwd - absolute workspace path.
 * @returns the legacy paths.
 */
export function legacyPaths(cwd) {
  const root = join(resolve(cwd), ...LEGACY_DIRECTORY.split("/"));
  return {
    root,
    notes: join(root, "notes"),
    stats: join(root, "stats.json"),
  };
}

/**
 * Read the legacy `stats.json`, if there is one.
 *
 * A missing or malformed file yields empty maps rather than an error: usage counts are a nice-to-have
 * and must not block importing the cards themselves.
 *
 * @param path - `stats.json` path.
 * @returns load counts and last-retrieval dates by card name.
 */
async function readLegacyStats(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const hits = new Map();
    const lastUsed = new Map();
    for (const [name, value] of Object.entries(raw?.hits ?? {})) {
      if (Number.isInteger(value) && value >= 0) hits.set(name, value);
    }
    for (const [name, value] of Object.entries(raw?.lastUsed ?? {})) {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) lastUsed.set(name, value);
    }
    return { hits, lastUsed };
  } catch {
    return { hits: new Map(), lastUsed: new Map() };
  }
}

/**
 * List the files under one legacy card's attachment directory.
 *
 * @param directory - the card's directory.
 * @returns relative paths with their absolute locations.
 */
async function listLegacyAssets(directory) {
  const root = join(directory, ASSET_DIRECTORY);
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else found.push({ path: relative(root, next).split("\\").join("/"), file: next });
    }
  };
  await walk(root);
  return found;
}

/**
 * Read everything the legacy layout holds for one workspace, without writing anything.
 *
 * @param cwd - absolute workspace path.
 * @returns the readable cards, the unreadable ones, and the layout's paths.
 */
export async function scanLegacy(cwd) {
  const paths = legacyPaths(cwd);
  const exists = await stat(paths.notes).then((info) => info.isDirectory(), () => false);
  if (!exists) {
    return { found: false, paths, cards: [], unreadable: [], stats: { hits: 0, lastUsed: 0 } };
  }

  const stats = await readLegacyStats(paths.stats);
  const cards = [];
  const unreadable = [];

  for (const entry of (await readdir(paths.notes, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(paths.notes, entry.name);
    const file = join(directory, CARD_FILE);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      unreadable.push({ name: entry.name, reason: `缺少 ${CARD_FILE}` });
      continue;
    }
    try {
      const { fields, body } = parseCard(text);
      const name = assertCardName(entry.name);
      cards.push({
        name,
        description: typeof fields.description === "string" && fields.description.trim() !== ""
          ? fields.description.trim()
          : name,
        whenToUse: typeof fields.whenToUse === "string" ? fields.whenToUse.trim() : undefined,
        triggers: listField(fields, "triggers"),
        tags: listField(fields, "tags"),
        status: fields.status,
        published: fields.publish === true,
        revision: fields.revision,
        created: fields.created,
        updated: fields.updated,
        body,
        hits: stats.hits.get(name) ?? 0,
        lastUsed: stats.lastUsed.get(name),
        assets: await listLegacyAssets(directory),
        source: directory,
      });
    } catch (error) {
      unreadable.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    found: true,
    paths,
    cards,
    unreadable,
    stats: { hits: stats.hits.size, lastUsed: stats.lastUsed.size },
  };
}

/**
 * Compare a legacy scan against what the database already holds.
 *
 * @param store - resolved store handle.
 * @param scan - a {@link scanLegacy} result.
 * @returns per-card status plus the totals the UI shows before asking for confirmation.
 */
export async function previewLegacy(store, scan) {
  const existing = new Map((await listCards(store)).map((card) => [card.name, card]));
  const rows = [];
  for (const card of scan.cards) {
    const current = existing.get(card.name);
    rows.push({
      name: card.name,
      description: card.description,
      assets: card.assets.length,
      hits: card.hits,
      tiers: card.updated,
      // `conflict` is not an error: the same card can legitimately exist in both places, and the
      // caller decides whether the file version should replace the stored one.
      action: current === undefined ? "create" : "conflict",
      existingRevision: current?.revision,
    });
  }
  return {
    found: scan.found,
    notes: scan.paths.notes,
    statsFile: scan.paths.stats,
    cards: rows,
    unreadable: scan.unreadable,
    totals: {
      cards: rows.length,
      create: rows.filter((row) => row.action === "create").length,
      conflict: rows.filter((row) => row.action === "conflict").length,
      assets: rows.reduce((sum, row) => sum + row.assets, 0),
      unreadable: scan.unreadable.length,
    },
  };
}

/**
 * Import a legacy scan into the database.
 *
 * @param store - resolved store handle.
 * @param scan - a {@link scanLegacy} result.
 * @param options - `overwrite` replaces a card that already exists; without it, conflicts are skipped.
 * @returns what was written, skipped, and failed.
 */
export async function importLegacy(store, scan, options = {}) {
  const overwrite = options.overwrite === true;
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const card of scan.cards) {
    try {
      const existing = await getCard(store, card.name);
      if (existing !== undefined && !overwrite) {
        skipped.push({ name: card.name, reason: "数据库中已有同名卡片" });
        continue;
      }
      await importCard(store, card);
      // Importer writes assets after the card, because the foreign key requires the card to exist.
      let assets = 0;
      for (const asset of card.assets) {
        try {
          await importAsset(store, card.name, asset);
          assets += 1;
        } catch {
          failed.push({ name: card.name, reason: `附件 ${asset.path} 写入失败` });
        }
      }
      imported.push({ name: card.name, assets, overwritten: existing !== undefined });
    } catch (error) {
      failed.push({ name: card.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { imported, skipped, failed };
}

/**
 * Write one legacy asset into the database.
 *
 * Kept as its own exported step so the importer's failure handling can report a single unreadable
 * file without aborting the card it belongs to.
 *
 * @param store - resolved store handle.
 * @param name - card name.
 * @param asset - `{ path, file }` from the scan.
 */
async function importAsset(store, name, asset) {
  const bytes = await readFile(asset.file);
  await writeAsset(store, name, asset.path, new Uint8Array(bytes));
}

/**
 * Delete the legacy files for one workspace.
 *
 * Separate from the import on purpose: the import is reversible by re-running it, but deleting the
 * source files is not. The caller must ask for this explicitly, after an import it has verified.
 *
 * @param scan - a {@link scanLegacy} result.
 * @returns what was removed.
 */
export async function removeLegacy(scan) {
  const removed = [];
  if (!scan.found) return { removed };
  // Only the two known artifacts are touched; the parent `.dsh` directory may hold other plugins'
  // data and is left alone.
  for (const target of [scan.paths.notes, scan.paths.stats]) {
    const present = await stat(target).then(() => true, () => false);
    if (!present) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { removed };
}
