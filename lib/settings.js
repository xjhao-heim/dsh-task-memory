/**
 * Plugin settings: one editable, plugin-owned file.
 *
 * Why not write the profile's `cordis.patch.yml`, which is where DSH's own settings service stores
 * plugin configuration: this plugin ships **zero dependencies** and therefore has no YAML parser.
 * Rewriting a YAML file by hand risks corrupting a file the whole profile boots from, and a settings
 * panel is not worth that risk.
 *
 * So settings live in their own JSON file, and precedence is stated once, here:
 *
 *   settings file  >  loader config (`cordis.patch.yml`)  >  built-in defaults
 *
 * The file wins because it is what the user last touched in the UI. The loader config still works as
 * a seed for a fresh install or for a value that should ship with a deployment, and a user who
 * prefers files can keep using it — the panel simply shows the effective value either way.
 *
 * @module dsh-task-memory/settings
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Fields the settings file owns. Anything else in the file is ignored. */
const KNOWN = new Set([
  "defaultTiers",
  "tierDays",
  "maxCatalogCards",
  "maxBodyChars",
  "autoCapture",
  "includeSystemPrompt",
]);

/**
 * The built-in defaults, which are the values the plugin uses when neither the settings file nor the
 * loader config says anything.
 *
 * These mirror `resolveConfig` in the plugin entry. They are duplicated rather than imported because
 * the entry imports this module, and a cycle would be worse than a second copy of six numbers —
 * `test/settings.test.js` pins them against the entry's own defaults so the two cannot drift apart
 * unnoticed.
 */
export const DEFAULT_SETTINGS = {
  defaultTiers: ["recent"],
  tierDays: { past: 7, old: 30, ancient: 90, forgotten: 365 },
  maxCatalogCards: 50,
  maxBodyChars: 24_000,
  autoCapture: true,
  includeSystemPrompt: true,
};

/**
 * Resolve one field's effective value: stored, else loader config, else the built-in default.
 *
 * @param loaderConfig - the config the loader passed to `apply`.
 * @param stored - the settings file contents.
 * @returns the effective values for every known field.
 */
function resolveConfigShape(loaderConfig, stored) {
  const base = loaderConfig !== null && typeof loaderConfig === "object" ? loaderConfig : {};
  const pick = (key) => (stored[key] !== undefined ? stored[key] : base[key]);
  const days = { ...DEFAULT_SETTINGS.tierDays, ...(base.tierDays ?? {}), ...(stored.tierDays ?? {}) };
  return {
    defaultTiers: pick("defaultTiers") ?? DEFAULT_SETTINGS.defaultTiers,
    tierDays: days,
    maxCatalogCards: pick("maxCatalogCards") ?? DEFAULT_SETTINGS.maxCatalogCards,
    maxBodyChars: pick("maxBodyChars") ?? DEFAULT_SETTINGS.maxBodyChars,
    autoCapture: pick("autoCapture") ?? DEFAULT_SETTINGS.autoCapture,
    includeSystemPrompt: pick("includeSystemPrompt") ?? DEFAULT_SETTINGS.includeSystemPrompt,
  };
}

/**
 * Resolve the global settings file.
 *
 * Settings are user preferences, not workspace data, so they live under the DSH home rather than
 * beside any one workspace's cards.
 *
 * @param env - environment to read `DSH_HOME` from.
 * @returns the settings file path.
 */
export function settingsPath(env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "task-memory", "settings.json");
}

/**
 * Read the stored settings.
 *
 * A missing, unreadable, or malformed file yields `{}` rather than an error: settings are an
 * override layer, and a broken override must not stop the plugin from mounting.
 *
 * @param path - settings file path.
 * @returns the stored fields, or an empty object.
 */
export async function readSettingsFile(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (KNOWN.has(key)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Write the settings file atomically.
 *
 * Same temporary-then-rename discipline as a card: a crash mid-write must not leave a half-written
 * settings file that fails to parse on the next boot.
 *
 * @param path - settings file path.
 * @param values - the complete field set to store.
 */
export async function writeSettingsFile(path, values) {
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    if (KNOWN.has(key) && value !== undefined) clean[key] = value;
  }
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Merge the stored settings over the loader config.
 *
 * The result is the raw config object the normalizer already understands, so the rest of the plugin
 * keeps one code path regardless of where a value came from.
 *
 * @param loaderConfig - the config the loader passed to `apply`.
 * @param stored - the settings file contents.
 * @returns the effective raw config.
 */
export function mergeSettings(loaderConfig, stored) {
  const base = loaderConfig !== null && typeof loaderConfig === "object" ? loaderConfig : {};
  if (stored === null || typeof stored !== "object") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    // `tierDays` merges per field: a settings file that only changes one boundary must not discard
    // the others, which would silently reset them to defaults.
    if (key === "tierDays" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      merged.tierDays = { ...(base.tierDays ?? {}), ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Read the settings file synchronously.
 *
 * `apply` is synchronous and every consumer needs resolved values before it returns, so the initial
 * read cannot await. Reading a small JSON file once at mount is cheap; later reads go through the
 * handle's cached copy.
 *
 * @param path - settings file path.
 * @returns the stored fields, or an empty object.
 */
export function readSettingsFileSync(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (KNOWN.has(key)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Build the live settings handle the plugin and the settings page share.
 *
 * One handle owns the file, the in-memory copy, and the effective merged config, so the settings page
 * and the running plugin can never disagree about what is configured. After an update the handle
 * re-resolves, which is what makes a save take effect without a restart for everything that reads the
 * effective config at call time.
 *
 * @param loaderConfig - the config the loader passed to `apply`.
 * @param env - environment used to resolve the DSH home.
 * @returns the handle: `effective()`, `snapshot()`, `update(patch)`, and `path`.
 */
export function createSettingsHandle(loaderConfig, env = process.env) {
  const path = settingsPath(env);
  let stored = readSettingsFileSync(path);
  return {
    path,
    /** The merged raw config, which is what the normalizer consumes. */
    effective: () => mergeSettings(loaderConfig, stored),
    /** The user-editable values only, as the settings page shows them. */
    snapshot: () => ({ ...stored }),
    /**
     * Apply and persist a change.
     * @param patch - the requested change; `{ reset: true }` clears everything.
     * @returns the stored values after the change.
     */
    async update(patch) {
      const next = applySettingsPatch(stored, patch);
      await writeSettingsFile(path, next);
      stored = next;
      return { ...next, ...(patch.reset === true ? { reset: true } : {}) };
    },
    /**
     * Write any parameter the local file does not carry yet, using the value the plugin is actually
     * running with.
     *
     * A settings page is a description of the configuration, and a description that omits every
     * parameter still at its default is incomplete: the user cannot see what the value is, and the
     * file gives no way to change it. Filling them in makes the file the complete account.
     *
     * The value written is the **effective** one, not the built-in default: a deployment that seeds
     * a parameter through the loader config must see that value in the file, or the file would
     * disagree with the running plugin.
     *
     * @returns the keys that were written, empty when the file was already complete.
     */
    async ensureDefaults() {
      const full = resolveConfigShape(loaderConfig, stored);
      const missing = Object.keys(full).filter((key) => stored[key] === undefined);
      if (missing.length === 0) return [];
      await writeSettingsFile(path, full);
      stored = full;
      return missing;
    },
    /**
     * Every parameter with its effective value, defaults included.
     * @returns the values the page displays.
     */
    effectiveView() {
      const effective = resolveConfigShape(loaderConfig, stored);
      return { ...DEFAULT_SETTINGS, ...effective };
    },
  };
}

/**
 * Apply a settings update.
 *
 * @param current - the current stored settings.
 * @param patch - the requested change; `{ reset: true }` clears everything.
 * @returns the next stored settings.
 * @throws {Error} when a value is present but unusable, so a bad save is refused instead of stored.
 */
export function applySettingsPatch(current, patch) {  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("设置更新必须是一个对象");
  }
  if (patch.reset === true) return {};

  const next = { ...current };
  const positive = (key, value, label) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error(`${label} 必须是正整数`);
    next[key] = number;
  };

  if (patch.defaultTiers !== undefined) {
    if (!Array.isArray(patch.defaultTiers)) throw new Error("默认档位必须是数组");
    // An empty selection would make the panel open on nothing, which reads as a broken panel; refuse
    // it rather than store a state the user cannot see their way out of.
    if (patch.defaultTiers.length === 0) throw new Error("默认档位至少要选一个");
    next.defaultTiers = patch.defaultTiers.filter((tier) => typeof tier === "string");
  }
  if (patch.tierDays !== undefined) {
    if (patch.tierDays === null || typeof patch.tierDays !== "object") throw new Error("档位边界必须是对象");
    const days = { ...(current.tierDays ?? {}) };
    for (const key of ["past", "old", "ancient", "forgotten"]) {
      if (patch.tierDays[key] !== undefined) positive(key, patch.tierDays[key], `「${key}」边界`);
    }
    // Enforce the increasing ladder at the write boundary: a non-increasing set makes a tier
    // unreachable, and accepting it would let the settings page create a state the index cannot
    // express.
    const merged = { ...(current.tierDays ?? {}), ...patch.tierDays };
    const ordered = ["past", "old", "ancient", "forgotten"].filter((key) => merged[key] !== undefined);
    for (let index = 1; index < ordered.length; index += 1) {
      if (!(Number(merged[ordered[index - 1]]) < Number(merged[ordered[index]]))) {
        throw new Error("档位边界必须递增（近期 < 之前 < 很久之前 < 远古 < 遗忘）");
      }
    }
    next.tierDays = merged;
  }
  if (patch.maxCatalogCards !== undefined) positive("maxCatalogCards", patch.maxCatalogCards, "索引上限");
  if (patch.maxBodyChars !== undefined) positive("maxBodyChars", patch.maxBodyChars, "正文上限");
  if (patch.autoCapture !== undefined) {
    if (typeof patch.autoCapture !== "boolean") throw new Error("自动落卡必须是布尔值");
    next.autoCapture = patch.autoCapture;
  }
  return next;
}
