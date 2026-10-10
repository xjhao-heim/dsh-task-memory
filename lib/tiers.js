/**
 * Recency tiers.
 *
 * The problem this solves: a memory library looks identical whether a card was proven yesterday or
 * abandoned a year ago, so the injected index treats them the same and fills the budget with cards
 * nobody needs. Tiering makes age visible and lets the index spend its space on live knowledge.
 *
 * Two decisions carry most of the weight:
 *
 *   1. **The clock is `max(updated, lastUsed)`.** A card that was just rewritten holds fresh
 *      knowledge; a card that was just retrieved is still needed. Either one means "not forgotten",
 *      so the later of the two is the honest answer. Using only `updated` would call a card fresh
 *      forever after one edit; using only `lastUsed` would call a brand-new card forgotten.
 *   2. **A tier is computed, never stored.** Same reason the index is derived: a stored tier is a
 *      value that goes stale the moment nobody runs the update. Nothing to migrate, nothing to
 *      invalidate.
 *
 * Tiers are a *separate axis* from `status`: status is a human judgement about whether the content
 * can be trusted; a tier is an automatic measurement of elapsed time. A card can be `stale` and
 * `recent` at once (doubted yesterday), or `verified` and `forgotten` (correct but untouched).
 * Merging them would make it impossible to say which one the user meant.
 *
 * @module dsh-task-memory/tiers
 */

/** Tier identifiers, in order from newest to oldest. */
export const TIER_ORDER = ["recent", "past", "old", "ancient", "forgotten"];

/** Chinese labels, shown in the index, the tools, and the panel. */
export const TIER_LABELS = {
  recent: "近期",
  past: "之前",
  old: "很久之前",
  ancient: "远古",
  forgotten: "遗忘",
};

/**
 * What a tier does to the injected index.
 *
 * The point of tiering is that older cards compete for less attention, not that they disappear: an
 * `ancient` card is still listed (by name) so the model can notice it exists, while a `forgotten`
 * one is only counted — the tools remain the way to reach it.
 */
export const TIER_DETAIL = {
  recent: "full",
  past: "full",
  old: "compact",
  ancient: "minimal",
  forgotten: "hidden",
};

/** Default day boundaries. Configurable, because a personal memory fills at its own rate. */
export const DEFAULT_TIER_DAYS = { past: 7, old: 30, ancient: 90, forgotten: 365 };

/**
 * Normalize the configured day boundaries.
 *
 * Boundaries must strictly increase or the tier lookup would skip a tier entirely, so a bad
 * configuration falls back to the default rather than producing a silently unreachable tier.
 *
 * @param raw - candidate boundaries.
 * @returns boundaries with all four fields present and increasing.
 */
export function resolveTierDays(raw) {
  const config = raw !== null && typeof raw === "object" ? raw : {};
  const read = (key) => {
    const value = Number(config[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIER_DAYS[key];
  };
  const days = { past: read("past"), old: read("old"), ancient: read("ancient"), forgotten: read("forgotten") };
  if (!(days.past < days.old && days.old < days.ancient && days.ancient < days.forgotten)) {
    return { ...DEFAULT_TIER_DAYS };
  }
  return days;
}

/**
 * Parse a `YYYY-MM-DD` date as local midnight.
 *
 * A card stores a calendar date, not an instant, so parsing it as UTC would shift the age by up to a
 * day depending on the reader's zone — enough to move a card across a boundary.
 *
 * @param value - date text.
 * @returns milliseconds since the epoch, or undefined when unparseable.
 */
export function parseDate(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day] = match;
  const time = new Date(Number(year), Number(month) - 1, Number(day)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/**
 * Render a timestamp back to the `YYYY-MM-DD` form cards use.
 * @param time - milliseconds since the epoch.
 * @returns the calendar date.
 */
export function formatDate(time) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Days between two instants, floored.
 * @param then - earlier instant.
 * @param now - later instant.
 * @returns whole days elapsed.
 */
function daysBetween(then, now) {
  return Math.floor((now - then) / 86_400_000);
}

/**
 * The instant a card was last meaningfully active.
 *
 * @param card - a card, or anything with `updated` and `created` date text.
 * @param lastUsed - ISO date of the last retrieval, when one was recorded.
 * @returns the newest known instant, or undefined when the card carries no usable date.
 */
export function activityTime(card, lastUsed) {
  const candidates = [
    parseDate(lastUsed),
    parseDate(card?.updated),
    parseDate(card?.created),
  ].filter((value) => value !== undefined);
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/**
 * Classify one card into a tier.
 *
 * A card with no usable date is treated as `forgotten` rather than `recent`: an unknown age must not
 * earn the attention that freshness buys.
 *
 * @param card - the card.
 * @param options - `lastUsed` date text, `now` instant, and resolved `days` boundaries.
 * @returns the tier id, elapsed days, and the instant the age was measured from.
 */
export function tierOf(card, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = options.days ?? DEFAULT_TIER_DAYS;
  const at = activityTime(card, options.lastUsed);
  if (at === undefined) return { tier: "forgotten", days: Number.POSITIVE_INFINITY, at: undefined };

  const elapsed = daysBetween(at, now);
  const tier = elapsed <= days.past ? "recent"
    : elapsed <= days.old ? "past"
      : elapsed <= days.ancient ? "old"
        : elapsed <= days.forgotten ? "ancient"
          : "forgotten";
  return { tier, days: elapsed, at };
}

/**
 * The date window that exactly covers a set of tiers.
 *
 * A tier is an interval of elapsed days and a card's date is `today - elapsed`, so the window is that
 * same interval measured in calendar dates. This is what lets the panel answer "show me 仅之前" with
 * a date range instead of leaving the pickers pointing at everything: the two filters then describe
 * one thing rather than two that contradict each other.
 *
 * `""` on a side means "no bound there" rather than an arbitrary early date — the forgotten tier has
 * no oldest card, so inventing one would hide a card dated before it.
 *
 * @param tiers - tier ids; the union of their windows is returned when several are given.
 * @param options - `now` instant and resolved `days` boundaries.
 * @returns `{from, to}` as `YYYY-MM-DD`, either side possibly empty.
 */
export function tierWindow(tiers, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = options.days ?? DEFAULT_TIER_DAYS;
  // The same boundaries `tierOf` applies, expressed as elapsed-day intervals. They must stay in step
  // with it: a window that disagrees with the classifier would show a card the tier excludes.
  const spans = {
    recent: [0, days.past],
    past: [days.past + 1, days.old],
    old: [days.old + 1, days.ancient],
    ancient: [days.ancient + 1, days.forgotten],
    forgotten: [days.forgotten + 1, Number.POSITIVE_INFINITY],
  };
  const wanted = (Array.isArray(tiers) ? tiers : []).filter((tier) => TIER_ORDER.includes(tier));
  if (wanted.length === 0) return { from: "", to: "" };

  // Smallest elapsed day = newest date; largest = oldest date.
  const newest = Math.min(...wanted.map((tier) => spans[tier][0]));
  const oldest = Math.max(...wanted.map((tier) => spans[tier][1]));
  return {
    from: Number.isFinite(oldest) ? dayOffset(now, oldest) : "",
    to: dayOffset(now, newest),
  };
}

/**
 * The calendar date a number of days before the day containing `time`.
 *
 * Shifts through `setDate` rather than subtracting milliseconds, so a DST transition in the reader's
 * zone cannot move the result onto the wrong day.
 *
 * @param time - milliseconds since the epoch.
 * @param offset - whole days to go back.
 * @returns the date text.
 */
function dayOffset(time, offset) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - offset);
  return formatDate(date.getTime());
}

/**
 * A short, human-readable age for a card line.
 *
 * Deliberately coarse: the exact day count of an old card is noise, and printing it invites the
 * reader to treat the number as meaningful.
 *
 * @param days - elapsed days.
 * @returns the age text.
 */
export function ageLabel(days) {
  if (!Number.isFinite(days)) return "日期未知";
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/**
 * Whether a tier still reaches the injected index.
 * @param tier - tier id.
 * @returns whether the tier is injected at all.
 */
export function isInjected(tier) {
  return TIER_DETAIL[tier] !== "hidden";
}

/**
 * Normalize the panel's default tier filter.
 *
 * An unusable value (unknown ids, or nothing selected) falls back to the recent tier rather than to
 * "everything": defaulting to everything would silently undo the tiering that was asked for.
 *
 * Lives here rather than in the plugin entry so the panel module can use it without importing the
 * entry module back (which would be a cycle).
 *
 * @param raw - candidate list of tier ids.
 * @returns a non-empty list of known tier ids.
 */
export function resolveDefaultTiers(raw) {
  if (!Array.isArray(raw)) return ["recent"];
  const wanted = raw.filter((tier) => TIER_ORDER.includes(tier));
  return wanted.length > 0 ? wanted : ["recent"];
}

/**
 * Sort cards newest-first by activity, then by name for stability.
 *
 * @param entries - objects carrying a `tier` result.
 * @returns a sorted copy.
 */
export function byRecency(entries) {
  return [...entries].sort((a, b) => {
    const left = a.classification.at ?? 0;
    const right = b.classification.at ?? 0;
    if (left !== right) return right - left;
    return String(a.card?.name ?? "").localeCompare(String(b.card?.name ?? ""));
  });
}
