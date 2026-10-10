/**
 * SQLite storage.
 *
 * One database for every workspace, at `$DSH_HOME/task-memory/memory.db`, with a `workspace` column
 * on each row. One file rather than one per workspace because a card can be copied between projects
 * and the whole store stays inspectable with a single tool; the column keeps the isolation that the
 * previous per-directory layout provided.
 *
 * `node:sqlite` is built into the runtime hosting the harness — verified on the installed Node
 * (v24.21.0) and already used by another plugin in this profile — so the store needs no dependency
 * and no native build. That constraint has driven every storage decision in this package.
 *
 * Concurrency: a single connection guarded by a promise queue. SQLite serializes writers anyway, and
 * a queue makes the read-modify-write of `saveCard` atomic with respect to other callers in this
 * process, which is the property the previous file store got from its per-root lock.
 *
 * @module dsh-task-memory/db
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Bumped when the schema changes; `migrate` brings an older file forward. */
export const SCHEMA_VERSION = 1;

/**
 * The schema.
 *
 * Timestamps stay TEXT in `YYYY-MM-DD` form: that is what the tier logic parses, what a human reads
 * on a card, and what makes lexical comparison equal to chronological comparison for a date, so no
 * conversion sits between storage and display.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  workspace   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  when_to_use TEXT,
  triggers    TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'verified',
  published   INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 1,
  created     TEXT NOT NULL DEFAULT '',
  updated     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  hits        INTEGER NOT NULL DEFAULT 0,
  last_used   TEXT,
  PRIMARY KEY (workspace, name)
);

CREATE INDEX IF NOT EXISTS cards_by_workspace_updated ON cards (workspace, updated DESC);

CREATE TABLE IF NOT EXISTS assets (
  workspace TEXT NOT NULL,
  card      TEXT NOT NULL,
  path      TEXT NOT NULL,
  bytes     BLOB NOT NULL,
  PRIMARY KEY (workspace, card, path),
  FOREIGN KEY (workspace, card) REFERENCES cards (workspace, name) ON DELETE CASCADE
);
`;

/**
 * Resolve the database path.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the database file path.
 */
export function databasePath(env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "task-memory", "memory.db");
}

/**
 * Open the database, creating and migrating it as needed.
 *
 * @param path - database file path, or `:memory:` for tests.
 * @returns the open connection.
 */
export function openDatabase(path = databasePath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL keeps a reader from blocking the writer; `:memory:` has no journal file to choose.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  // Off by default in SQLite, and the assets table depends on it to clean up with its card.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  if (row === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
  }
  return db;
}

/**
 * Serialize operations over one database connection.
 *
 * Every mutating store operation is read-modify-write (compare the existing card, then write), so
 * callers must not interleave. Reads go through the same queue: they are cheap, and letting them
 * bypass would let a read observe a half-applied save.
 */
const queues = new WeakMap();

/**
 * Run an operation with exclusive access to one database.
 *
 * @param db - the connection.
 * @param operation - work to run.
 * @returns the operation's value.
 */
export function withDatabase(db, operation) {
  const previous = queues.get(db) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // Keep the chain alive but never let a rejection poison the queue for later callers.
  queues.set(db, next.then(() => {}, () => {}));
  return next;
}

/**
 * Run a function inside a transaction.
 *
 * Used where several statements must land together — a card and its assets, or a legacy import of
 * many cards — so a failure part-way cannot leave a half-imported workspace.
 *
 * @param db - the connection.
 * @param work - synchronous work to run.
 * @returns the work's value.
 */
export function transact(db, work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  }
}

/**
 * Read one meta value.
 * @param db - the connection.
 * @param key - meta key.
 * @returns the stored value, or undefined.
 */
export function readMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
}

/**
 * Write one meta value.
 * @param db - the connection.
 * @param key - meta key.
 * @param value - value to store.
 */
export function writeMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

/** The connection used when a caller does not supply one. */
let shared = undefined;

/**
 * The process-wide connection, opened on first use.
 *
 * The plugin mounts once per profile, so one shared connection serves every workspace and session in
 * it; per-call connections would lose the write queue and re-run the pragmas constantly.
 *
 * @param path - override the default path (tests use `:memory:`).
 * @returns the shared connection.
 */
export function sharedDatabase(path) {
  if (shared === undefined) shared = openDatabase(path);
  return shared;
}

/**
 * Close the shared connection, if one is open.
 *
 * Called on plugin disposal so the file is not left locked across a reload, and by tests between
 * cases so an in-memory database does not leak into the next one.
 */
export function closeSharedDatabase() {
  if (shared === undefined) return;
  try {
    shared.close();
  } catch {
    // A connection already closed elsewhere is not an error worth surfacing during teardown.
  }
  shared = undefined;
}
