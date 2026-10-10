/**
 * Local deduplication scoring.
 *
 * The whole point of this plugin is that one task keeps one card. A model asked to "save what we
 * just did" will happily invent a second card for the same problem under a slightly different
 * name, so the store refuses to create one when a strong candidate already exists and hands the
 * candidate back instead.
 *
 * Everything here runs in-process on already-loaded card metadata: no network, no embeddings, no
 * index to keep in sync. Character trigram overlap plus trigger-word containment is enough to catch
 * the realistic case (the same task described twice in different words) while staying explainable —
 * the tool reports WHY it matched, so the model can disagree with a stated reason instead of
 * fighting a black box.
 *
 * @module dsh-task-memory/match
 */

/** Trigram overlap at or above this value is treated as the same task. */
const DUPLICATE_THRESHOLD = 0.55;

/** Candidates at or above this value are reported as "closely related" without blocking a create. */
const RELATED_THRESHOLD = 0.3;

/**
 * Generic name fragments that carry no task meaning.
 *
 * `card`, `task`, `fix`, `impl` and their kin are shared by huge numbers of unrelated names, so
 * counting them makes "other-card" look 40% similar to "target-card" on the name alone.
 */
const NAME_STOPWORDS = new Set([
  "card", "cards", "task", "tasks", "note", "notes", "memory", "memories",
  "fix", "fixes", "bug", "bugs", "impl", "implementation", "issue", "issues",
  "the", "and", "for", "with", "from", "how", "to", "of", "in", "on",
  "dsh", "plugin", "plugins", "flow", "process", "steps", "guide",
]);

/**
 * Normalize text for comparison: lowercase, and collapse everything that is not a letter, digit, or
 * CJK character into single spaces.
 *
 * CJK text has no word boundaries to exploit, so trigrams over the collapsed string are what makes
 * Chinese task names comparable at all.
 *
 * @param value - raw text.
 * @returns normalized text.
 */
export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

/**
 * Split a kebab-case or prose name into meaningful words, dropping generic fragments.
 * @param value - raw name.
 * @returns the significant words.
 */
function nameWords(value) {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 0 && !NAME_STOPWORDS.has(word));
}

/**
 * Build the character trigram set of a string, padded so short strings still produce trigrams.
 * @param value - normalized text.
 * @returns the trigram set.
 */
export function trigrams(value) {
  const text = ` ${normalize(value)} `;
  const set = new Set();
  if (text.trim() === "") return set;
  for (let index = 0; index + 3 <= text.length; index += 1) set.add(text.slice(index, index + 3));
  return set;
}

/**
 * Jaccard-style overlap of two trigram sets, measured against the smaller set.
 *
 * Dividing by the smaller set (rather than the union) is deliberate: a short "表格闪烁" and a long
 * "QTableView 滚动闪烁" describe one task, and a union denominator would punish the length
 * difference until the pair fell below the threshold.
 *
 * @param left - first trigram set.
 * @param right - second trigram set.
 * @returns a score in [0, 1].
 */
function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / small.size;
}

/**
 * Score two names by their significant words.
 *
 * Character trigrams compare scripts badly: a Chinese description and an English one for the same
 * task share almost no trigrams even though they share the concept. Word overlap after dropping
 * generic fragments keeps the signal that matters (the distinctive words) and discards the noise
 * (`card`, `plugin`, `fix`) that made unrelated names look similar.
 *
 * @param left - first name.
 * @param right - second name.
 * @returns a score in [0, 1] and the words that matched.
 */
function wordOverlap(left, right) {
  const a = new Set(nameWords(left));
  const b = new Set(nameWords(right));
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared = [...a].filter((word) => b.has(word));
  if (shared.length === 0) return { score: 0, shared: [] };
  return { score: shared.length / Math.min(a.size, b.size), shared };
}

/**
 * Score one candidate card against an incoming card's routing text.
 *
 * @param candidate - existing card routing text.
 * @param incoming - incoming card routing text.
 * @returns the score and the reasons that produced it.
 */
function scorePair(candidate, incoming) {
  const reasons = [];

  const names = wordOverlap(candidate.name, incoming.name);
  if (names.score >= RELATED_THRESHOLD) {
    reasons.push(`名称含相同关键词：${names.shared.join("、")}`);
  }

  // Description and triggers are compared as prose, where trigrams are the only usable signal for
  // CJK: there are no word boundaries to split a Chinese sentence on.
  const textScore = overlap(
    trigrams(`${candidate.description} ${candidate.whenToUse ?? ""}`),
    trigrams(`${incoming.description} ${incoming.whenToUse ?? ""}`),
  );
  if (textScore >= RELATED_THRESHOLD) reasons.push(`描述相似 ${(textScore * 100).toFixed(0)}%`);

  const incomingTriggers = new Set(incoming.triggers.map((item) => normalize(item)).filter((item) => item !== ""));
  // Report the candidate's original spelling, not the normalized form: the reason line is read by a
  // model and by a human, and `setUniformRowHeights` is far more recognizable than its lowercase.
  const shared = candidate.triggers
    .filter((item) => item.trim() !== "" && incomingTriggers.has(normalize(item)));
  const triggerScore = shared.length === 0
    ? 0
    : shared.length / Math.min(candidate.triggers.length, incoming.triggers.length);
  if (shared.length > 0) reasons.push(`触发词重合：${shared.join("、")}`);

  const tagShared = candidate.tags
    .map((item) => normalize(item))
    .filter((item) => incoming.tags.map((tag) => normalize(tag)).includes(item));
  if (tagShared.length > 0) reasons.push(`标签重合：${tagShared.join("、")}`);

  // Name identity is decisive on its own; otherwise the best available evidence carries the score.
  const score = Math.max(names.score, textScore, triggerScore);
  return { score, reasons };
}

/**
 * Rank existing cards against a card that is about to be stored.
 *
 * Score dominates; recency breaks ties. When two cards match equally well, the fresher one is almost
 * always the right target — it is the card someone has been maintaining, while the other is the one
 * that went stale — so the suggestion the model receives points at the card worth updating.
 *
 * @param cards - existing cards.
 * @param incoming - the incoming card's routing text.
 * @param options - optional `activityOf(name)` returning the card's last-activity instant.
 * @returns the ranked candidates, strongest first.
 */
export function rankCandidates(cards, incoming, options = {}) {
  const activityOf = typeof options.activityOf === "function" ? options.activityOf : () => 0;
  return cards
    .map((card) => {
      const { score, reasons } = scorePair(card, incoming);
      return { card, score, reasons, activity: activityOf(card.name) ?? 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || b.activity - a.activity
      || a.card.name.localeCompare(b.card.name));
}

/**
 * Decide whether an incoming card is a restatement of an existing one.
 *
 * The card being saved is excluded from both lists by name: an update matches itself perfectly, and
 * reporting "the card you are updating is related to the card you are updating" is noise.
 *
 * @param cards - existing cards.
 * @param incoming - the incoming card's routing text.
 * @param options - optional `activityOf(name)` returning the card's last-activity instant.
 * @returns the decision, the blocking duplicate when there is one, and near misses.
 */
export function classify(cards, incoming, options = {}) {
  const ranked = rankCandidates(cards, incoming, options);
  const others = ranked.filter((entry) => entry.card.name !== incoming.name);
  const duplicate = others.find((entry) => entry.score >= DUPLICATE_THRESHOLD);
  const related = others.filter((entry) => entry !== duplicate && entry.score >= RELATED_THRESHOLD);
  return { duplicate, related, ranked };
}

/** Exported for tests and for the tool description, so the threshold is stated in one place. */
export const THRESHOLDS = { duplicate: DUPLICATE_THRESHOLD, related: RELATED_THRESHOLD };
