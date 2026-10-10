/**
 * Test entry point.
 *
 * `node --test` spawns a child process per file, which the sandbox denies. Importing the suites into
 * one process runs exactly the same `node:test` assertions without the spawn, so `npm test` works
 * wherever the plugin does.
 *
 * @module dsh-task-memory/test
 */

import "./setup.js";
import "./frontmatter.test.js";
import "./store.test.js";
import "./match.test.js";
import "./tiers.test.js";
import "./settings.test.js";
import "./legacy.test.js";
import "./plugin.test.js";
import "./panel.test.js";
import "./dropdown.test.js";
import "./capture.test.js";
