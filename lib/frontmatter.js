/**
 * Restricted YAML frontmatter codec for memory cards.
 *
 * Why not use the `yaml` package: this plugin is loaded by path (a junction into the profile's
 * `node_modules`), so Node's resolution walk never reaches the profile and every bare specifier
 * fails. The card frontmatter is a closed, plugin-owned shape, so a deliberately small codec is
 * both sufficient and safer than a general parser: it accepts exactly the forms this module
 * writes, plus the plain hand edits a human makes in the same shape.
 *
 * Supported syntax inside the `---` block:
 *   key: scalar              (bare, 'single', or "double" quoted)
 *   key: [a, b, c]           (flow list)
 *   key:                     (block list follows, one `  - item` per line)
 *     - item
 *
 * Anything else raises, so a malformed card is reported instead of silently misread.
 *
 * @module dsh-task-memory/frontmatter
 */

/** Card fields whose value is a list of strings. */
const LIST_FIELDS = new Set(["triggers", "tags"]);

/** Card fields whose value is a number. */
const NUMBER_FIELDS = new Set(["revision", "hits"]);

/** Card fields whose value is a boolean. */
const BOOLEAN_FIELDS = new Set(["publish"]);

/** Card fields kept in canonical serialization order. */
const FIELD_ORDER = [
  "name",
  "description",
  "whenToUse",
  "triggers",
  "tags",
  "status",
  "publish",
  "revision",
  "hits",
  "created",
  "updated",
];

/**
 * Strip one layer of matching quotes and unescape the escapes the writer emits.
 * @param raw - raw scalar text.
 * @returns the decoded scalar.
 */
function decodeScalar(raw) {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    const body = text.slice(1, -1);
    return body.replace(/\\(["\\ntr])/g, (_, ch) => {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      return ch;
    });
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * Parse an inline flow list such as `[a, "b, c"]`.
 * @param raw - text between the brackets, without the brackets.
 * @returns the decoded list items.
 */
function decodeFlowList(raw) {
  const items = [];
  let current = "";
  let quote = "";
  for (const ch of raw) {
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => decodeScalar(item)).filter((item) => item.length > 0);
}

/**
 * Split a card file into its frontmatter mapping and body.
 *
 * @param text - complete file text.
 * @returns the parsed fields and the trimmed body.
 * @throws {Error} when the frontmatter block is missing or malformed.
 */
export function parseCard(text) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized.trimStart().startsWith("---") === false) {
    throw new Error("card has no YAML frontmatter block");
  }
  const start = normalized.indexOf("---");
  const rest = normalized.slice(start + 3);
  const end = rest.indexOf("\n---");
  if (end === -1) throw new Error("card frontmatter block is not closed with ---");
  const header = rest.slice(0, end).replace(/^\n/, "");
  const body = rest.slice(end + 4).replace(/^\n+/, "").trimEnd();

  const fields = {};
  const lines = header.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) throw new Error(`unexpected indented line outside a list: ${JSON.stringify(line)}`);
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`frontmatter line is not a key/value pair: ${JSON.stringify(line)}`);
    const key = line.slice(0, colon).trim();
    if (key === "") throw new Error(`frontmatter line has an empty key: ${JSON.stringify(line)}`);
    const value = line.slice(colon + 1);

    if (value.trim() === "") {
      const items = [];
      while (index < lines.length && /^\s*-\s?/.test(lines[index])) {
        items.push(decodeScalar(lines[index].replace(/^\s*-\s?/, "")));
        index += 1;
      }
      if (items.length === 0) {
        fields[key] = "";
        continue;
      }
      fields[key] = items.filter((item) => item.length > 0);
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      if (!trimmed.endsWith("]")) throw new Error(`unterminated flow list for "${key}"`);
      fields[key] = decodeFlowList(trimmed.slice(1, -1));
      continue;
    }

    const scalar = decodeScalar(value);
    if (NUMBER_FIELDS.has(key)) {
      const asNumber = Number(scalar);
      fields[key] = Number.isFinite(asNumber) ? asNumber : scalar;
      continue;
    }
    // Unquoted `true`/`false` are YAML booleans. Quoted ones stay strings by design: the reader is
    // what a hand edit lands in, and `publish: "true"` clearly means the text, not the flag.
    if (BOOLEAN_FIELDS.has(key) && /^(true|false)$/i.test(scalar) && !/^["']/.test(value.trim())) {
      fields[key] = scalar.toLowerCase() === "true";
      continue;
    }
    fields[key] = scalar;
  }

  return { fields, body };
}

/**
 * Encode a scalar so a round trip through {@link parseCard} returns the same string.
 * @param value - scalar value.
 * @returns a safely quotable YAML scalar.
 */
function encodeScalar(value) {
  const text = String(value);
  // Quote whenever the text could be misread: a newline would break the line-oriented parse
  // outright, and leading/trailing space, YAML indicators, or a colon/hash could be taken as
  // structure by a reader.
  if (text === "" || /[\n\r\t]/.test(text) || /^[\s>|&*!%@`{}[\],"']/.test(text) || /\s$/.test(text)
    || /[:#]\s/.test(text) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(text)) {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  }
  return text;
}

/**
 * Serialize a card back to file text.
 *
 * Field order is canonical so an update produces a minimal, reviewable diff rather than a
 * reshuffled file.
 *
 * @param fields - card fields.
 * @param body - markdown body.
 * @returns complete file text ending in a newline.
 */
export function serializeCard(fields, body) {
  const lines = ["---"];
  const known = FIELD_ORDER.filter((key) => fields[key] !== undefined);
  const extra = Object.keys(fields).filter((key) => !FIELD_ORDER.includes(key)).sort();

  for (const key of [...known, ...extra]) {
    const value = fields[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${encodeScalar(item)}`);
      continue;
    }
    if (typeof value === "number" && NUMBER_FIELDS.has(key)) {
      lines.push(`${key}: ${value}`);
      continue;
    }
    // A boolean must serialize as a YAML boolean. Passing it through `encodeScalar` would quote it
    // (the encoder protects bare `true`/`false` from being read as strings) and the reader would
    // then hand back the string "true" — silently losing a flag like `publish`.
    if (typeof value === "boolean") {
      lines.push(`${key}: ${value ? "true" : "false"}`);
      continue;
    }
    lines.push(`${key}: ${encodeScalar(value)}`);
  }

  lines.push("---", "");
  const trimmed = String(body ?? "").replace(/\r\n/g, "\n").trim();
  lines.push(trimmed === "" ? "" : trimmed);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Read a list field defensively: a hand edit may leave a single string where a list belongs.
 * @param fields - parsed card fields.
 * @param key - field name.
 * @returns the list value, or an empty array.
 */
export function listField(fields, key) {
  const value = fields[key];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/**
 * Whether a field name is one this codec models as a string list.
 * @param key - field name.
 * @returns whether the key is a list field.
 */
export function isListField(key) {
  return LIST_FIELDS.has(key);
}
