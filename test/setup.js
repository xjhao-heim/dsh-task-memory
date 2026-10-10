/**
 * Test environment.
 *
 * The store resolves its database path from `DSH_HOME`, so pointing that at a throwaway directory
 * keeps every test away from the user's real memory file. This module must be imported before any
 * test that reaches the shared connection; the connection is opened lazily on first use, so setting
 * the variable in a module body (which runs before any test does) is early enough.
 *
 * Imported by `all.test.js` and by each suite that drives the plugin, so a suite run on its own is
 * still isolated.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "task-memory-test-home-"));
