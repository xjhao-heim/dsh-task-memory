/**
 * Settings tests.
 *
 * The settings file is an override layer over the loader config, and it is written by a UI, so the
 * cases that matter are precedence, merge behaviour, completing the file on read, and refusing a
 * value that would leave the plugin in a state the index cannot express.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import "./setup.js";
import {
  applySettingsPatch,
  createSettingsHandle,
  DEFAULT_SETTINGS,
  mergeSettings,
  readSettingsFile,
  readSettingsFileSync,
  settingsPath,
  writeSettingsFile,
} from "../lib/settings.js";

/**
 * A throwaway DSH home.
 * @returns an environment whose settings file has not been written.
 */
async function home() {
  const dir = await mkdtemp(join(tmpdir(), "task-memory-settings-"));
  return { DSH_HOME: dir };
}

test("the settings file lives under the DSH home, not in a workspace", () => {
  const path = settingsPath({ DSH_HOME: "C:\\dsh-home" });
  assert.match(path, /dsh-home[\\/]task-memory[\\/]settings\.json$/);
});

test("a missing or malformed file reads as no overrides", async () => {
  const env = await home();
  const path = settingsPath(env);
  assert.deepEqual(await readSettingsFile(path), {}, "missing file");
  assert.deepEqual(readSettingsFileSync(path), {}, "missing file, sync");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json", "utf8");
  assert.deepEqual(await readSettingsFile(path), {}, "malformed file");

  await writeFile(path, "[1,2,3]", "utf8");
  assert.deepEqual(await readSettingsFile(path), {}, "a non-object is not settings");
});

test("unknown fields are dropped, so a stray key cannot reach the plugin", async () => {
  const env = await home();
  const path = settingsPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ autoCapture: false, evil: "x" }), "utf8");

  const stored = await readSettingsFile(path);
  assert.deepEqual(Object.keys(stored), ["autoCapture"]);
  assert.equal(stored.autoCapture, false);
});

test("writing is atomic and round-trips the known fields", async () => {
  const env = await home();
  const path = settingsPath(env);
  await writeSettingsFile(path, { autoCapture: true, maxCatalogCards: 20, unknown: 1 });

  const text = await readFile(path, "utf8");
  assert.match(text, /^\{\n/, "pretty-printed JSON");
  const stored = JSON.parse(text);
  assert.equal(stored.autoCapture, true);
  assert.equal(stored.maxCatalogCards, 20);
  assert.equal("unknown" in stored, false);
});

test("the settings file wins over the loader config", () => {
  const merged = mergeSettings({ autoCapture: true, maxCatalogCards: 50 }, { autoCapture: false });
  assert.equal(merged.autoCapture, false, "the value the user last touched wins");
  assert.equal(merged.maxCatalogCards, 50, "untouched fields keep the loader value");
});

test("tierDays merges per field rather than replacing the whole object", () => {
  // Replacing it would silently reset every boundary the settings file did not mention.
  const merged = mergeSettings({ tierDays: { past: 7, old: 30, ancient: 90, forgotten: 365 } }, { tierDays: { past: 3 } });
  assert.deepEqual(merged.tierDays, { past: 3, old: 30, ancient: 90, forgotten: 365 });
});

test("reset clears every override", () => {
  const next = applySettingsPatch({ autoCapture: false, defaultTiers: ["recent"] }, { reset: true });
  assert.deepEqual(next, {});
});

test("a valid patch is accepted", () => {
  const next = applySettingsPatch({}, {
    defaultTiers: ["recent", "past"],
    tierDays: { past: 5, old: 20, ancient: 60, forgotten: 200 },
    maxCatalogCards: 30,
    maxBodyChars: 12000,
    autoCapture: false,
  });
  assert.deepEqual(next.defaultTiers, ["recent", "past"]);
  assert.deepEqual(next.tierDays, { past: 5, old: 20, ancient: 60, forgotten: 200 });
  assert.equal(next.maxCatalogCards, 30);
  assert.equal(next.autoCapture, false);
});

test("an empty default tier selection is refused", () => {
  // Storing it would make the panel open on nothing, which reads as a broken panel.
  assert.throws(() => applySettingsPatch({}, { defaultTiers: [] }), /至少要选一个/);
});

test("a non-increasing ladder is refused at the write boundary", () => {
  // Accepting it would leave a tier unreachable, a state the index cannot express.
  assert.throws(
    () => applySettingsPatch({}, { tierDays: { past: 30, old: 7, ancient: 90, forgotten: 365 } }),
    /必须递增/,
  );
  assert.throws(
    () => applySettingsPatch({}, { tierDays: { past: 7, old: 7, ancient: 90, forgotten: 365 } }),
    /必须递增/,
  );
});

test("a partial ladder is checked against the stored values", () => {
  // Setting only `past` must still be ordered against the boundaries already on file.
  assert.throws(
    () => applySettingsPatch({ tierDays: { past: 7, old: 30, ancient: 90, forgotten: 365 } }, { tierDays: { past: 100 } }),
    /必须递增/,
  );
  const ok = applySettingsPatch({ tierDays: { past: 7, old: 30, ancient: 90, forgotten: 365 } }, { tierDays: { past: 3 } });
  assert.equal(ok.tierDays.past, 3);
  assert.equal(ok.tierDays.old, 30);
});

test("non-positive numbers, wrong types, and non-objects are refused", () => {
  for (const patch of [
    { maxCatalogCards: 0 },
    { maxCatalogCards: -5 },
    { maxCatalogCards: 1.5 },
    { maxBodyChars: "many" },
    { autoCapture: "yes" },
    { defaultTiers: "recent" },
    { tierDays: null },
    null,
    [],
  ]) {
    assert.throws(() => applySettingsPatch({}, patch), /必须|设置更新/, `patch ${JSON.stringify(patch)}`);
  }
});

test("the live handle merges, persists, and re-resolves", async () => {
  const env = await home();
  const handle = createSettingsHandle({ autoCapture: true, maxCatalogCards: 50 }, env);

  assert.equal(handle.effective().autoCapture, true, "loader config applies before any override");
  assert.equal(handle.effective().maxCatalogCards, 50);
  assert.deepEqual(handle.snapshot(), {}, "nothing stored yet");

  await handle.update({ autoCapture: false });
  assert.equal(handle.effective().autoCapture, false, "the override is visible immediately");
  assert.equal(handle.snapshot().autoCapture, false);
  assert.equal(JSON.parse(await readFile(handle.path, "utf8")).autoCapture, false, "and it is on disk");

  await handle.update({ reset: true });
  assert.deepEqual(handle.snapshot(), {});
  assert.equal(handle.effective().autoCapture, true, "reset falls back to the loader config");

  // A second handle reads the same file, which is what makes the setting survive a restart.
  await handle.update({ maxCatalogCards: 7 });
  const reopened = createSettingsHandle({ maxCatalogCards: 50 }, env);
  assert.equal(reopened.effective().maxCatalogCards, 7);
});

test("ensureDefaults writes every parameter the local file is missing", async () => {
  const env = await home();
  const handle = createSettingsHandle({ maxCatalogCards: 99 }, env);

  // A page that shows a parameter's value must be able to point at where it is stored, so reading
  // the settings is also what completes the file.
  const filled = await handle.ensureDefaults();
  assert.ok(filled.includes("tierDays"), "the boundaries are written");
  assert.ok(filled.includes("maxBodyChars"));

  const onDisk = JSON.parse(await readFile(handle.path, "utf8"));
  assert.deepEqual(onDisk.tierDays, DEFAULT_SETTINGS.tierDays);
  assert.equal(onDisk.maxBodyChars, DEFAULT_SETTINGS.maxBodyChars);
  // The value written is the EFFECTIVE one, not the built-in default: a deployment that seeds a
  // parameter through the loader config must see that value in the file.
  assert.equal(onDisk.maxCatalogCards, 99);

  const again = await handle.ensureDefaults();
  assert.deepEqual(again, [], "a complete file needs nothing written");
});

test("ensureDefaults never overwrites a value the user already set", async () => {
  const env = await home();
  const handle = createSettingsHandle({}, env);
  await handle.update({ autoCapture: false, maxCatalogCards: 3 });

  await handle.ensureDefaults();
  const onDisk = JSON.parse(await readFile(handle.path, "utf8"));
  assert.equal(onDisk.autoCapture, false, "a deliberate false must survive");
  assert.equal(onDisk.maxCatalogCards, 3);
  assert.equal(onDisk.includeSystemPrompt, true, "while the untouched fields are filled in");
});

test("effectiveView exposes every parameter with its resolved value", async () => {
  const env = await home();
  const handle = createSettingsHandle({ maxBodyChars: 111 }, env);
  await handle.update({ autoCapture: false });
  const view = handle.effectiveView();

  assert.equal(view.maxBodyChars, 111, "the loader config is visible");
  assert.equal(view.autoCapture, false, "and so is the stored override");
  assert.equal(view.maxCatalogCards, DEFAULT_SETTINGS.maxCatalogCards, "and so is the built-in default");
  assert.deepEqual(Object.keys(view).sort(), [
    "autoCapture", "defaultTiers", "includeSystemPrompt", "maxBodyChars", "maxCatalogCards", "tierDays",
  ], "the page can rely on every field being present");
});

test("the built-in defaults match the plugin's own resolver", async () => {
  // The defaults are duplicated rather than imported (the entry imports this module, so importing
  // back would be a cycle), and this is what keeps the two copies from drifting apart.
  const { resolveConfig } = await import("../lib/index.js");
  const fromEntry = resolveConfig({});
  assert.deepEqual(DEFAULT_SETTINGS.defaultTiers, fromEntry.defaultTiers);
  assert.deepEqual(DEFAULT_SETTINGS.tierDays, fromEntry.tierDays);
  assert.equal(DEFAULT_SETTINGS.maxCatalogCards, fromEntry.maxCatalogCards);
  assert.equal(DEFAULT_SETTINGS.maxBodyChars, fromEntry.maxBodyChars);
  assert.equal(DEFAULT_SETTINGS.autoCapture, fromEntry.autoCapture);
  assert.equal(DEFAULT_SETTINGS.includeSystemPrompt, fromEntry.includeSystemPrompt);
});
