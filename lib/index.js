/**
 * dsh-task-memory — workspace-scoped task memory.
 *
 * What this plugin is for: the same task keeps coming back, and every session re-derives the same
 * conclusion from scratch. This plugin stores one card per task and makes the cards discoverable in
 * two stages, so a long memory never has to be read in full:
 *
 *   1. INDEX  — every card is registered as a skill, so the skill catalog (one line per card) is
 *               the index. It is already injected into the session, and the registry republishes it
 *               only when it actually changes.
 *   2. BODY   — the built-in `skill` tool loads the one card that matched, and nothing else.
 *
 * The alternative — one big memory blob read every session — is what this design exists to avoid.
 *
 * Cards live in `<cwd>/.dsh/task-memory/notes/<name>/SKILL.md`. The same file is both the durable
 * memory and the skill body, so there is no second copy to drift.
 *
 * @module dsh-task-memory
 */

import { readFile } from "node:fs/promises";
import { defineTool } from "./schema.js";
import { classify, THRESHOLDS } from "./match.js";
import { registerPanelRoutes } from "./panel.js";
import { registerTurnCapture } from "./capture.js";
import { createSettingsHandle } from "./settings.js";
import {
  activityTime,
  ageLabel,
  byRecency,
  isInjected,
  resolveDefaultTiers as resolveDefaultTiersFromTiers,
  resolveTierDays,
  TIER_DETAIL,
  TIER_LABELS,
  TIER_ORDER,
  tierOf,
} from "./tiers.js";
import {
  closeSharedDatabase,
  deleteCard,
  getCard,
  listAssets,
  listCards,
  readAsset,
  readStats,
  recordHit,
  resolveStore,
  saveCard,
  searchCards,
  STATUSES,
} from "./store.js";

/** Plugin name as the loader sees it. */
export const name = "dsh-task-memory";

/** Services this plugin needs: the tool registry, the skill registry, and the prompt registry. */
export const inject = ["tools", "skills"];

/** Provider name shown as the skill source. */
const PROVIDER_NAME = "task-memory";

/** Cards are runtime-tier: a project skill of the same name still wins. */
const PROVIDER_RANK = 320;

/** Default cap on how many cards reach the injected catalog. */
const DEFAULT_MAX_CATALOG_CARDS = 50;

/** Default body size ceiling for one card, in characters. */
const DEFAULT_MAX_BODY_CHARS = 24_000;

/**
 * Resolve loader config.
 * @param raw - raw loader config.
 * @returns resolved config with every field present.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === "object" ? raw : {};
  const maxCards = Number(config.maxCatalogCards);
  const maxBody = Number(config.maxBodyChars);
  return {
    maxCatalogCards: Number.isInteger(maxCards) && maxCards > 0 ? maxCards : DEFAULT_MAX_CATALOG_CARDS,
    maxBodyChars: Number.isInteger(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY_CHARS,
    includeSystemPrompt: config.includeSystemPrompt !== false,
    // On by default: without it nothing is recorded unless the user asks, which defeats the plugin.
    autoCapture: config.autoCapture !== false,
    // Day boundaries between the recency tiers. A personal memory fills at its own rate, so these
    // are configuration rather than constants.
    tierDays: resolveTierDays(config.tierDays),
    // Which tiers the panel opens on. Defaults to the recent tier alone: the point of tiering is
    // that the newest knowledge is what deserves the first look.
    defaultTiers: resolveDefaultTiers(config.defaultTiers),
  };
}

/**
 * Normalize the panel's default tier filter.
 *
 * @param raw - candidate list of tier ids.
 * @returns a non-empty list of known tier ids.
 */
export function resolveDefaultTiers(raw) {
  return resolveDefaultTiersFromTiers(raw);
}

/**
 * Build a text content block.
 * @param text - block text.
 * @returns a text content block.
 */
function text(value) {
  return { type: "text", text: value };
}

/** The tool output shape shared by every tool in this plugin. */
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    properties: { text: { type: "string", required: true } },
    additionalProperties: true,
  },
  render: (_args, value) => [text(value.text)],
};

/**
 * Read the session working directory from a tool execution.
 *
 * A card belongs to the workspace that produced it; without a cwd there is no workspace to scope to,
 * so this fails loudly rather than silently writing into some other directory.
 *
 * @param exec - tool run context.
 * @returns the absolute cwd.
 */
function storeFor(exec) {
  return resolveStore(resolveWorkspace(exec?.agent?.session?.header?.cwd));
}

/**
 * Resolve a workspace root defensively.
 *
 * The skill provider's `list()`/`get()` receive a lookup context rather than a tool execution, and
 * a lookup may arrive without a cwd (a scope-only read, for example). Returning `undefined` there
 * means "this workspace contributes no cards", which is the honest answer — never a guess at some
 * other directory.
 *
 * @param cwd - candidate working directory.
 * @returns the absolute workspace path, or undefined.
 */
function resolveWorkspace(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  try {
    resolveStore(cwd);
    return cwd;
  } catch {
    return undefined;
  }
}

/**
 * Report secret-looking text so a card never becomes a place credentials quietly accumulate.
 *
 * Advisory only: the tool warns and stores, because refusing would tempt the model to bury the same
 * string somewhere with less scrutiny.
 *
 * @param text - text about to be stored.
 * @returns a warning line, or undefined.
 */
function secretWarning(value) {
  const text = String(value ?? "");
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i,
  ];
  const hit = patterns.find((pattern) => pattern.test(text));
  return hit === undefined
    ? undefined
    : "注意：卡片正文里出现了疑似密钥/令牌的内容。请把凭据改成占位符或指向保管位置，不要把真实密钥写进记忆卡。";
}

/**
 * Build the card-shaped view the matching code scores, from tool arguments.
 * @param args - save arguments.
 * @returns the incoming card routing text.
 */
function incomingCard(args) {
  return {
    name: args.name ?? "",
    description: args.description ?? "",
    whenToUse: args.whenToUse,
    triggers: args.triggers ?? [],
    tags: args.tags ?? [],
  };
}

/**
 * Format a candidate line for a tool result.
 * @param entry - a ranked candidate.
 * @returns one readable line.
 */
function candidateLine(entry) {
  const reasons = entry.reasons.length > 0 ? `（${entry.reasons.join("；")}）` : "";
  return `- \`${entry.card.name}\` ${entry.card.description}${reasons}`;
}

/**
 * Register the memory tools.
 *
 * @param ctx - the plugin context.
 * @param config - resolved config.
 * @param refreshIndexFor - re-materializes the injected index after a write, so the next prompt
 *   assembly shows what was just stored instead of a stale list.
 * @returns disposers, one per registered tool.
 */
function registerTools(ctx, config, refreshIndexFor) {
  const disposers = [];

  disposers.push(ctx.tools.register(defineTool({
    name: "task_memory_index",
    description:
      "List this workspace's task-memory cards — the full index. Each line is one remembered task "
      + "(name, description, triggers, status, last update, load count). Use it when the injected "
      + "index does not show a matching card, or to check whether a task was already recorded before "
      + "saving it. Load a card's content with `task_memory_load` (published cards also load through "
      + "the `skill` tool).",
    parameters: {
      query: { type: "string", description: "Only cards whose name, description, triggers, tags, or body contain this text." },
      status: { type: "string", enum: STATUSES, description: "Only cards in this lifecycle state." },
      tag: { type: "string", description: "Only cards carrying this tag." },
      tier: {
        type: "string",
        enum: TIER_ORDER,
        description: "Only cards at this recency tier (recent / past / old / ancient / forgotten). "
          + "Tiers are computed from the last activity, so this is the way to ask for the old cards "
          + "the injected index leaves out.",
      },
      limit: { type: "integer", description: "Maximum rows to return (default 50)." },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const store = storeFor(exec);
      const stats = await readStats(store);
      let cards = await listCards(store);

      const query = args.query?.trim();
      if (query !== undefined && query !== "") {
        const pattern = query.toLowerCase();
        cards = cards.filter((card) => {
          const haystack = [
            card.name,
            card.description,
            card.whenToUse ?? "",
            card.triggers.join(" "),
            card.tags.join(" "),
            card.body,
          ].join("\n").toLowerCase();
          return haystack.includes(pattern);
        });
      }
      if (args.status !== undefined) cards = cards.filter((card) => card.status === args.status);
      if (args.tag !== undefined && args.tag !== "") {
        const wanted = args.tag.toLowerCase();
        cards = cards.filter((card) => card.tags.some((item) => item.toLowerCase() === wanted));
      }
      // Filter by tier before the limit is applied, so "show me the forgotten cards" returns them
      // rather than whatever fitted the cap first.
      if (args.tier !== undefined) {
        cards = cards.filter((card) => tierOf(card, {
          lastUsed: stats.lastUsed.get(card.name),
          days: config.tierDays,
          now: Date.now(),
        }).tier === args.tier);
      }

      const total = cards.length;
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 50;
      // The list is ordered by recency tier first, then by proven usefulness, and every row carries
      // its tier and age so the reader can tell a card proven yesterday from one untouched for a year.
      const shown = cards
        .map((card) => ({
          card,
          hits: stats.hits.get(card.name) ?? 0,
          classification: tierOf(card, {
            lastUsed: stats.lastUsed.get(card.name),
            days: config.tierDays,
            now: Date.now(),
          }),
        }))
        .sort((a, b) => {
          const order = TIER_ORDER.indexOf(a.classification.tier) - TIER_ORDER.indexOf(b.classification.tier);
          if (order !== 0) return order;
          return b.hits - a.hits;
        })
        .slice(0, limit);

      if (total === 0) {
        const all = await listCards(store);
        return {
          text: all.length === 0
            ? `这个工作区还没有任务记忆卡。\n任务结束后，若形成了可复用的做法，用 task_memory_save 落一张卡。`
            : "没有符合条件的卡片。去掉过滤条件再试，或用 task_memory_search 做全文检索。",
        };
      }

      const tierCounts = new Map();
      for (const row of cards.map((card) => tierOf(card, {
        lastUsed: stats.lastUsed.get(card.name),
        days: config.tierDays,
        now: Date.now(),
      }))) {
        tierCounts.set(row.tier, (tierCounts.get(row.tier) ?? 0) + 1);
      }
      const summary = TIER_ORDER
        .filter((tier) => tierCounts.has(tier))
        .map((tier) => `${TIER_LABELS[tier]} ${tierCounts.get(tier)}`)
        .join("、");

      const lines = [
        `任务记忆索引：${total} 张卡（${summary}）${total > shown.length ? `，显示前 ${shown.length} 张` : ""}。`,
        "",
      ];
      for (const { card, hits, classification } of shown) {
        const flags = [
          card.status === "verified" ? "" : card.status,
        ].filter((item) => item !== "");
        lines.push(`- \`${card.name}\`〔${TIER_LABELS[classification.tier]}〕：${card.description}`
          + (card.triggers.length > 0 ? `；触发：${card.triggers.join("、")}` : "")
          + `；${ageLabel(classification.days)}；r${card.revision}；加载 ${hits} 次`
          + (flags.length > 0 ? `；${flags.join("；")}` : ""));
      }
      lines.push("", "用 `task_memory_load` 按名字取某张卡的完整内容；`task_memory_search` 可做正文全文检索。"
        + "上架过的卡也能用 `skill` 工具加载。");
      return { text: lines.join("\n") };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "task_memory_load",
    description:
      "Load one task-memory card's full content by name, plus the list of files stored beside it. "
      + "This works for every card in the workspace; published cards also load through the built-in "
      + "`skill` tool.",
    parameters: {
      name: { type: "string", required: true, description: "Card name, exactly as shown in the index." },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const store = storeFor(exec);
      const card = await getCard(store, args.name);
      if (card === undefined) {
        const cards = await listCards(store);
        const hint = cards.length === 0
          ? "这个工作区还没有任何记忆卡。"
          : `现有卡片：${cards.slice(0, 20).map((item) => item.name).join("、")}${cards.length > 20 ? " …" : ""}`;
        return { text: `没有名为 \`${args.name}\` 的记忆卡。${hint}` };
      }
      const assets = await listAssets(store, card.name);
      // Read the stats BEFORE recording this load, so the reported tier reflects how stale the card
      // was when it was asked for — which is the interesting fact — rather than the load just made.
      const stats = await readStats(store);
      const classification = tierOf(card, {
        lastUsed: stats.lastUsed.get(card.name),
        days: config.tierDays,
        now: Date.now(),
      });
      await recordHit(store, card.name);
      const body = card.body.length > config.maxBodyChars
        ? `${card.body.slice(0, config.maxBodyChars)}\n\n…（正文超过 ${config.maxBodyChars} 字符已截断，用 task_memory_asset 取完整附件）`
        : card.body;
      const lines = [
        `# ${card.name}`,
        card.description,
        card.whenToUse !== undefined ? `适用时机：${card.whenToUse}` : "",
        `状态：${card.status}；新鲜度：${TIER_LABELS[classification.tier]}（${ageLabel(classification.days)}）`
          + `；版本：r${card.revision}；更新：${card.updated || "未知"}`,
        card.triggers.length > 0 ? `触发词：${card.triggers.join("、")}` : "",
        card.tags.length > 0 ? `标签：${card.tags.join("、")}` : "",
        assets.length > 0 ? `附件：${assets.join("、")}（用 task_memory_asset 读取）` : "",
        "",
        body,
      ].filter((line) => line !== "");
      return { text: lines.join("\n") };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "task_memory_asset",
    description:
      "Read one file stored beside a memory card (a code snippet, a patch, a config fragment). "
      + "`task_memory_load` lists a card's assets; this reads one by path. Assets live in the memory "
      + "database, so this is the way to reach them.",
    parameters: {
      name: { type: "string", required: true, description: "Card name." },
      path: { type: "string", required: true, description: "Asset path as listed by task_memory_load, e.g. patch/fix.diff." },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const store = storeFor(exec);
      const card = await getCard(store, args.name);
      if (card === undefined) return { text: `没有名为 \`${args.name}\` 的记忆卡。` };
      const bytes = await readAsset(store, args.name, args.path);
      if (bytes === undefined) {
        const assets = await listAssets(store, args.name);
        return {
          text: assets.length === 0
            ? `卡片 \`${args.name}\` 没有附件。`
            : `卡片 \`${args.name}\` 没有附件 \`${args.path}\`。现有：${assets.join("、")}`,
        };
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      // Binary assets are reported rather than decoded into noise: a card holding an image should
      // say so instead of returning replacement characters.
      const binary = text.includes("\u0000") || text.includes("\uFFFD");
      if (binary) {
        return { text: `附件 \`${args.path}\`（${bytes.length} 字节）不是文本，无法直接显示。` };
      }
      return { text: `# ${args.name} / ${args.path}\n\n${text}` };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "task_memory_save",
    description:
      "Record what this task taught you as a reusable card. One task keeps exactly ONE card: the "
      + "default mode refuses to create a second card for a task that already looks recorded and "
      + "returns the existing card instead, so pass that card's name with mode 'update' to fold the "
      + "new findings into it. Use mode 'force-create' only when the candidate really is a different "
      + "task. Save after finishing work that produced a non-obvious conclusion, a fixed pitfall, or "
      + "a reusable procedure — not for one-off lookups or trivial edits. Cards stay in this "
      + "workspace's memory by default; pass publish: true only when the finding deserves to be a "
      + "general skill listed in the harness skill catalog.",
    parameters: {
      name: { type: "string", required: true, description: "Kebab-case card name, e.g. qt-tableview-flicker." },
      description: { type: "string", required: true, description: "One line stating what task this card answers. This line is what the index shows." },
      body: { type: "string", required: true, description: "Card content as markdown with `## 适用场景` / `## 做法` / `## 验证` / `## 坑` style sections. Required even when updating." },
      whenToUse: { type: "string", description: "When this card applies, in one sentence." },
      triggers: { type: "array", items: { type: "string" }, description: "Words and phrases that should select this card later (symptom names, API names, error text)." },
      tags: { type: "array", items: { type: "string" }, description: "Short topic labels." },
      status: { type: "string", enum: STATUSES, description: "Lifecycle state; defaults to verified." },
      publish: {
        type: "boolean",
        description: "Publish this card as a harness skill (default false). Published cards appear in "
          + "the skill catalog and the Skill Center page; unpublished cards stay in the task-memory "
          + "index only. Publishing is sticky until explicitly set back to false.",
      },
      mode: {
        type: "string",
        enum: ["auto", "update", "force-create"],
        description: "auto (default) refuses to create a near-duplicate; update folds into the named existing card; force-create creates regardless.",
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const store = storeFor(exec);
      const mode = args.mode ?? "auto";
      const existing = await getCard(store, args.name);
      const cards = await listCards(store);
      // When two cards match equally well, prefer the fresher one as the update target: it is the
      // card someone has been maintaining, rather than the one that went stale.
      const saveStats = await readStats(store);
      const { duplicate, related } = classify(cards, incomingCard(args), {
        activityOf: (name) => activityTime(cards.find((card) => card.name === name), saveStats.lastUsed.get(name)) ?? 0,
      });

      if (existing === undefined && mode !== "force-create" && duplicate !== undefined) {
        return {
          text: [
            `没有创建新卡：\`${args.name}\` 与已有卡 \`${duplicate.card.name}\` 看起来是同一件事。`,
            candidateLine(duplicate),
            "",
            "同一件事只保留一张卡。请改为把新结论合并进那张卡：",
            `  task_memory_save({ name: "${duplicate.card.name}", mode: "update", description: "...", body: "..." })`,
            "确实是一个不同任务时，才用 mode: \"force-create\" 新建。",
          ].join("\n"),
        };
      }

      const stored = await saveCard(store, {
        name: args.name,
        description: args.description,
        whenToUse: args.whenToUse,
        triggers: args.triggers,
        tags: args.tags,
        status: args.status,
        body: args.body,
        ...(typeof args.publish === "boolean" ? { publish: args.publish } : {}),
        allowUpdate: true,
      });
      // The injected index is a cache; refresh it so the next assembly reflects this write.
      await refreshIndexFor(store.workspace).catch(() => {});

      const warning = secretWarning(`${args.body}\n${args.description}`);
      const verb = stored.outcome === "created" ? "已创建" : "已更新";
      const lines = [
        `${verb}记忆卡 \`${stored.card.name}\`（r${stored.card.revision}，状态 ${stored.card.status}）。`,
        `索引行：${stored.card.catalogDescription()}`,
        stored.card.published
          ? "这张卡已上架：它同时出现在技能目录/技能中心里，可以直接用 `skill` 工具加载。"
          : "这张卡未上架：它只在任务记忆索引里，用 `task_memory_load` 或 `task_memory_search` 取用，"
            + "不会出现在技能中心。确实值得当作通用技能时，用 `publish: true` 上架。",
        stored.outcome === "updated"
          ? "合并规则：只替换你这次写到的 `##` 段落，没提到的段落原样保留。"
            + "`triggers` 与 `tags` 是**并集**：这次没写的旧词保留，但写过的旧词也删不掉——"
            + "要删词得在任务记忆面板里改（人工编辑是逐字替换）。"
          : "",
        related.length > 0
          ? `另外还有相关的卡，必要时看一下是否应该合并：\n${related.slice(0, 5).map(candidateLine).join("\n")}`
          : "",
        warning ?? "",
      ].filter((line) => line !== "");
      return { text: lines.join("\n") };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "task_memory_search",
    description:
      "Full-text search across this workspace's task-memory card bodies, returning a snippet per "
      + "hit. The index only shows one line per card, so use this when a card may cover your task "
      + "without any of its trigger words appearing in the request.",
    parameters: {
      query: { type: "string", required: true, description: "Text to find. Interpreted as a regular expression when regex is true." },
      regex: { type: "boolean", description: "Treat query as a regular expression (default false)." },
      caseSensitive: { type: "boolean", description: "Match case-sensitively (default false)." },
      limit: { type: "integer", description: "Maximum matches to return (default 20)." },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const store = storeFor(exec);
      let matches;
      try {
        matches = await searchCards(store, args.query, {
          regex: args.regex,
          caseSensitive: args.caseSensitive,
          limit: args.limit,
          days: config.tierDays,
        });
      } catch (error) {
        return { text: `检索表达式无效：${error instanceof Error ? error.message : String(error)}` };
      }
      if (matches.length === 0) {
        return { text: `没有匹配「${args.query}」的记忆卡。也可以先用 task_memory_index 看完整索引。` };
      }
      // Newest first: search is how an old card gets reached, but a recent hit is more likely to be
      // the current truth, so the reader sees it before the historical one.
      const ordered = [...matches].sort((a, b) => {
        const order = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
        return order !== 0 ? order : String(b.updated).localeCompare(String(a.updated));
      });
      return {
        text: [
          `匹配 ${ordered.length} 张卡（按新鲜度排序）：`,
          "",
          ...ordered.map((match) => `- \`${match.name}\`〔${TIER_LABELS[match.tier]}，${ageLabel(match.days)}，`
            + `${match.status}〕\n  ${match.snippet}`),
          "",
          "用 `task_memory_load` 加载需要的卡。旧卡不一定还适用，先看日期再采信。",
        ].join("\n"),
      };
    },
  })));

  return disposers;
}

/**
 * Invalidate the skill catalog so the next read re-collects from disk.
 *
 * `registerProvider`'s `control.invalidate()` is the documented way to say "this provider's catalog
 * changed": it bumps the registry revision, drops the collect cache, and notifies observers. The
 * revision is part of the registry's cache key, so the next `snapshot()` — which `tool-skill` runs
 * on every `agent/pre-step` — necessarily re-reads this provider instead of serving a stale list.
 *
 * Without this a publish change only surfaces on the next natural re-collect, which means a card
 * could be published (or withdrawn) and the skill catalog would keep showing the old set.
 *
 * Set once the provider is registered; a no-op until then and after disposal.
 */
let invalidateCatalog = () => {};

/**
 * Register the card catalog as a skill provider.
 *
 * This is what makes published cards appear in the harness skill catalog (and the Skill Center page
 * that reads it), refreshed by the host rather than by this plugin.
 *
 * @param ctx - the plugin context.
 * @param config - resolved config.
 * @returns a disposer that unregisters the provider.
 */
function registerProvider(ctx, config) {
  return ctx.skills.registerProvider((control) => {
    // Keep the control's invalidator, but only while this exact registration is live: the signal
    // aborts on disposal, and a stale invalidator must not be called afterwards.
    invalidateCatalog = () => {
      if (control.signal.aborted) return;
      control.invalidate();
    };
    control.signal.addEventListener("abort", () => {
      invalidateCatalog = () => {};
    }, { once: true });

    return {
      name: PROVIDER_NAME,

      async list(options = {}) {
        const workspace = resolveWorkspace(options.cwd);
        if (workspace === undefined) return [];
        const store = resolveStore(workspace);
        const [cards, stats] = await Promise.all([listCards(store), readStats(store)]);
        const usable = cards;

        // Only deliberately published cards become skills. Registering every card made the harness
        // skill catalog (and the Skill Center page that reads it) the dumping ground for this
        // plugin's internal storage: cards are memory, most of them are not instructions anyone
        // browses for, and the Skill Center cannot even edit them — it lists runtime entries with no
        // path, so they appeared there as inert rows. Cards stay reachable through task_memory_index /
        // task_memory_search and through the index injected below, whatever their published state.
        const published = usable.filter((card) => card.published);

        // The catalog is injected into every request, so it is capped. Recency leads: a card the
        // plugin has decided is forgotten has no business occupying the skill list either, and it
        // stays reachable through the tools.
        const ranked = published
          .map((card) => ({
            card,
            hits: stats.hits.get(card.name) ?? 0,
            classification: tierOf(card, {
              lastUsed: stats.lastUsed.get(card.name),
              days: config.tierDays,
              now: config.now ?? Date.now(),
            }),
          }))
          .filter((row) => isInjected(row.classification.tier))
          .sort((a, b) => {
            const order = TIER_ORDER.indexOf(a.classification.tier) - TIER_ORDER.indexOf(b.classification.tier);
            if (order !== 0) return order;
            return b.hits - a.hits;
          })
          .slice(0, config.maxCatalogCards);

        return ranked.map(({ card }) => ({
          name: card.name,
          description: card.catalogDescription(),
          ...(card.whenToUse !== undefined ? { whenToUse: card.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: "runtime",
          provider: PROVIDER_NAME,
          rank: PROVIDER_RANK,
          locator: { workspace, name: card.name },
          // A card has no file any more, so it is a virtual skill: there is no directory a relative
          // reference could resolve against. Assets are addressed by name through the plugin's own
          // tool, which is what the description points at.
          resourceBase: {
            kind: "opaque",
            description: `记忆卡「${card.name}」存在任务记忆数据库中；附件用 task_memory_asset 读取。`,
          },
          metadata: { revision: card.revision, status: card.status, updated: card.updated },
        }));
      },

      async get(candidate, options = {}) {
        const locator = candidate?.locator;
        const cardName = locator !== null && typeof locator === "object" ? locator.name : undefined;
        if (typeof cardName !== "string") return undefined;
        // The locator carries the workspace it was listed for, so a cached candidate still resolves
        // against the right store instead of guessing a root back out of a file path.
        const workspace = typeof locator?.workspace === "string" ? locator.workspace : resolveWorkspace(options.cwd);
        if (workspace === undefined) return undefined;
        const store = resolveStore(workspace);
        const card = await getCard(store, cardName);
        if (card === undefined) return undefined;
        await recordHit(store, card.name);
        return {
          name: card.name,
          description: card.catalogDescription(),
          ...(card.whenToUse !== undefined ? { whenToUse: card.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: "runtime",
          provider: PROVIDER_NAME,
          resourceBase: {
            kind: "opaque",
            description: `记忆卡「${card.name}」存在任务记忆数据库中；附件用 task_memory_asset 读取。`,
          },
          content: card.body,
        };
      },
    };
  });
}

/**
 * Cache of the injected card index, keyed by workspace.
 *
 * A prompt section's text provider is synchronous and runs on every assembly, while reading cards is
 * asynchronous. The index is therefore materialized by the operations that can change it (save,
 * delete, and the first read of a workspace) and read back synchronously here.
 */
const indexCache = new Map();

/**
 * Rebuild the injected index for one workspace.
 *
 * Every card is listed, published or not: publication only decides whether a card also appears in
 * the harness skill catalog, never whether the model can find it. This is the index that keeps an
 * unpublished card discoverable without turning it into a skill.
 *
 * @param workspace - absolute workspace path.
 * @param config - resolved config.
 * @returns the refreshed cache entry.
 */
async function refreshIndex(workspace, config) {
  const store = resolveStore(workspace);
  const [cards, stats] = await Promise.all([listCards(store), readStats(store)]);
  const usable = cards;

  // Each card is classified once here and the result cached, so the render path stays synchronous
  // and never has to consult the clock.
  const classified = usable.map((card) => ({
    card,
    hits: stats.hits.get(card.name) ?? 0,
    classification: tierOf(card, {
      lastUsed: stats.lastUsed.get(card.name),
      days: config.tierDays,
      now: config.now ?? Date.now(),
    }),
  }));

  // Within a tier, a card that has proven useful leads. Across tiers, recency wins — that ordering
  // is the whole point of tiering, so it is applied before popularity.
  const ranked = byRecency(classified).sort((a, b) => {
    const order = TIER_ORDER.indexOf(a.classification.tier) - TIER_ORDER.indexOf(b.classification.tier);
    if (order !== 0) return order;
    return b.hits - a.hits;
  });

  const entry = {
    total: usable.length,
    published: usable.filter((card) => card.published).length,
    ranked,
    limit: config.maxCatalogCards,
  };
  indexCache.set(workspace, entry);
  return entry;
}

/**
 * Render the injected index section.
 *
 * Bounded on purpose: the whole point of this plugin is that a long memory is never read in full,
 * so the injected part stays a bounded list and the rest is reachable through the tools.
 *
 * Tiers decide how much of each card is spent. Recent and past cards get their full routing line
 * (description plus triggers, which is what makes a card matchable); older tiers shrink to a name or
 * a bare list, and forgotten cards are only counted. That is the "different retrieval frequency" the
 * design calls for: age costs attention before it costs access — every card stays reachable through
 * `task_memory_index` / `task_memory_search` whatever tier it is in.
 *
 * @param entry - one cache entry.
 * @returns the section text.
 */
function renderIndex(entry) {
  if (entry.total === 0) {
    return [
      "### 任务记忆索引",
      "",
      `本工作区还没有记忆卡（目录：${entry.notes}）。任务结束后若形成可复用的做法，用 \`task_memory_save\` 落卡。`,
    ].join("\n");
  }

  const counts = new Map();
  for (const row of entry.ranked) {
    counts.set(row.classification.tier, (counts.get(row.classification.tier) ?? 0) + 1);
  }
  const summary = TIER_ORDER
    .filter((tier) => counts.has(tier))
    .map((tier) => `${TIER_LABELS[tier]} ${counts.get(tier)}`)
    .join("、");

  const lines = [
    "### 任务记忆索引",
    "",
    `共 ${entry.total} 张卡（${summary}）${entry.published > 0 ? `，其中 ${entry.published} 张已上架为技能` : ""}。`,
    "越新的卡列得越详细；旧卡只留名字，遗忘档只计数——它们仍可用 `task_memory_search` 检索到。",
    "",
  ];

  // The injected budget is spent in tier order, so a large forgotten tail can never crowd out a
  // card that was proven this week.
  //
  // Two different things keep a card out of the list, and they must not be conflated: a `hidden`
  // tier is a decision about attention (the card is deliberately not advertised), while `overflow`
  // is merely the budget running out. Only the overflow set is named in the closing line — naming a
  // forgotten card there would contradict "遗忘档只计数" and leak its name into the prompt anyway.
  let spent = 0;
  const overflow = [];
  let forgottenCount = 0;
  for (const tier of TIER_ORDER) {
    const detail = TIER_DETAIL[tier];
    const rows = entry.ranked.filter((row) => row.classification.tier === tier);
    if (rows.length === 0) continue;
    if (detail === "hidden") {
      forgottenCount += rows.length;
      continue;
    }

    const room = remainingBudget(entry, spent);
    if (room <= 0) {
      overflow.push(...rows);
      continue;
    }
    const shown = rows.slice(0, room);
    overflow.push(...rows.slice(room));
    spent += shown.length;

    lines.push(`**${TIER_LABELS[tier]}**（${counts.get(tier)} 张）`);
    if (detail === "minimal") {
      // Minimal: names only, on one line, so dozens of old cards cost a few lines.
      lines.push(shown.map(({ card }) => `\`${card.name}\``).join("、") + "。");
    } else {
      for (const { card, hits, classification } of shown) {
        const flags = [
          card.status === "verified" ? "" : card.status,
          card.published ? "已上架" : "",
        ].filter((item) => item !== "");
        const head = detail === "compact"
          ? `- \`${card.name}\`：${card.description}`
          : `- \`${card.name}\`：${card.description}`
            + (card.triggers.length > 0 ? `；触发：${card.triggers.join("、")}` : "");
        lines.push(head
          + `；${ageLabel(classification.days)}`
          + (hits > 0 ? `；用过 ${hits} 次` : "")
          + (flags.length > 0 ? `；${flags.join("、")}` : ""));
      }
    }
    lines.push("");
  }

  if (overflow.length > 0) {
    const names = overflow.slice(0, 12).map(({ card }) => `\`${card.name}\``).join("、");
    lines.push(`索引已达上限，另有 ${overflow.length} 张未列出`
      + (names === "" ? "" : `（${names}${overflow.length > 12 ? " …" : ""}）`)
      + "。用 `task_memory_index` 看全部。");
    lines.push("");
  }
  if (forgottenCount > 0) {
    // Names are deliberately withheld: the forgotten tier's contract is that these cards stop being
    // advertised. They remain reachable by search, which is the point of separating attention from
    // access.
    lines.push(`另有 ${forgottenCount} 张已进入遗忘档（很久未用），不再列出；`
      + "需要时用 `task_memory_search` 检索，或在面板里清理。");
    lines.push("");
  }
  lines.push("命中就用 `task_memory_load` 加载那一张；上架过的卡在技能目录里也能看到。");
  return lines.join("\n");
}

/**
 * Remaining injection budget.
 *
 * A named helper rather than an inline field read, so the cap is consulted in exactly one place and
 * every tier honours the same number.
 *
 * @param entry - the cache entry carrying the cap.
 * @param spent - rows already emitted.
 * @returns how many more cards may be listed.
 */
function remainingBudget(entry, spent) {
  return Math.max(0, entry.limit - spent);
}

/**
 * The standing instruction that makes the memory actually get used.
 *
 * Without it the model has a catalog it never consults and a save tool it never calls — the memory
 * would be correct and inert.
 *
 * @returns the prompt section text.
 */
function workflowSection() {
  return [
    "## 任务记忆（dsh-task-memory）",
    "",
    "本工作区把「做过的任务」存成记忆卡，避免每次都从头分析。",
    "下方「任务记忆索引」列出了本工作区的卡片摘要。",
    "",
    "开工前：索引里有描述与你当前任务相符的卡时，先调 `task_memory_load` 取那张卡，",
    "按卡里的做法和验证方式执行，**不要重新从头分析**。",
    "索引被截断、或你认为这件事以前可能做过但没看到合适的卡时，调 `task_memory_index` 看完整索引，",
    "或调 `task_memory_search` 做正文全文检索。上架过的卡也能用 `skill` 工具加载。",
    "",
    "收尾时：回合结束会有一条自动检查提醒你回顾本轮。若这轮满足下面任一条，就调 `task_memory_save` 落卡",
    "（同一件事只保留一张卡）：",
    "- 排查出了根因，或试错后找到了正确做法；",
    "- 形成了可复用的步骤、命令、配置或接口用法；",
    "- 踩到了不明显的坑，值得下次提前避开；",
    "- 用户说「记住这个」。",
    "不必等到提醒才存——想存就存。纯查询、纯读取、没有非显然结论的小改动，不要落卡。",
    "",
    "落卡要点：",
    "- `name` 用 kebab-case，`description` 写清这张卡回答什么问题（这一行就是索引里显示的内容）；",
    "- `triggers` 填症状名、API 名、报错片段等以后能用来命中它的词，中英文都写上；",
    "- `body` 用 `## 适用场景` / `## 做法` / `## 验证` / `## 坑` 这类段落写；",
    "- 同一件事已有卡时，用 `mode: \"update\"` 更新那张卡（只替换你写到的段落），不要新建；",
    "- 卡里不要写密钥、令牌等凭据。",
    "",
    "**默认不要上架**：卡片默认只留在本工作区的任务记忆里，不进技能目录（技能中心是给人挑通用技能的地方，",
    "不该被本工作区的排查记录塞满）。只有当一个发现确实值得当作跨任务的通用技能时，才加 `publish: true`。",
  ].join("\n");
}

/**
 * The index section registered per agent.
 *
 * The section has to be associated with one session's working directory: cards are workspace-scoped,
 * and the global prompt section cannot see which session is being assembled. Registering through
 * `agent.ctx` inside `agent/created` gives exactly that scope, and the registration dies with the
 * agent instead of leaking across sessions.
 *
 * The index itself is served from the cache, because a prompt section's text provider is synchronous
 * while reading cards is not.
 *
 * @param agent - the newly created agent.
 * @param config - resolved config.
 * @param refresh - callback that (re)materializes the cache for a workspace.
 * @returns a disposer for the agent-scoped registration.
 */
function registerIndexSection(agent, config, refresh) {
  const workspace = resolveWorkspace(agent?.session?.header?.cwd);
  if (workspace === undefined) return () => {};

  const systemPrompt = agent.ctx?.get?.("systemPrompt") ?? agent.ctx?.systemPrompt;
  if (systemPrompt === undefined) return () => {};
  return systemPrompt.section({
    name: "dsh-task-memory-index",
    order: systemPrompt.getSectionOrder("TOOL_SESSION_QUERY") - 1,
    text: () => {
      const cached = indexCache.get(workspace);
      return cached === undefined ? "" : renderIndex(cached);
    },
  });
}

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin context.
 * @param rawConfig - raw loader config.
 */
export function apply(ctx, rawConfig) {
  // Settings live in their own file and win over the loader config, so a change made in the settings
  // page is visible to the very next read without touching the profile's patch file. The file is
  // read synchronously here because `apply` is synchronous and every consumer below needs the
  // resolved values; a missing file is normal and yields `{}`.
  const settings = createSettingsHandle(rawConfig);
  const config = resolveConfig(settings.effective());

  if (ctx.get("skills") === undefined) {
    throw new Error(
      "dsh-task-memory needs the skills service (inject: [\"skills\"]). Mount "
        + "@deepseek-ai/dsh-skill in this profile; without it the card catalog cannot be indexed.",
    );
  }

  // Every card write changes two derived views: the injected index, which this plugin caches, and
  // the skill catalog, which the registry caches by revision. One callback refreshes both, so a
  // publish (or withdrawal) shows up in the Skill Center and the session's skill list immediately
  // instead of waiting for the next natural re-collect.
  const refresh = async (workspace) => {
    await refreshIndex(workspace, config);
    invalidateCatalog();
  };

  ctx.effect(() => registerProvider(ctx, config), "dsh-task-memory: card catalog provider");
  for (const dispose of registerTools(ctx, config, refresh)) {
    ctx.effect(() => dispose, "dsh-task-memory: tool registration");
  }

  // The database opens on first use rather than here: a profile that never touches memory should not
  // create a file, and the connection must be released on unload so a reload is not left holding a
  // lock. `closeSharedDatabase` is idempotent, so an unopened database is not an error.
  ctx.effect(() => () => closeSharedDatabase(), "dsh-task-memory: database lifecycle");

  // The browser panel needs an HTTP carrier. `ctx.inject` waits for the service instead of reading
  // it once at mount: the web server may be composed after this plugin, and a profile without one
  // (headless, CLI) must still mount every other feature.
  const mountPanel = (scope) => {
    const dispose = registerPanelRoutes(scope, ctx.logger, refresh, config.tierDays, config.defaultTiers, settings);
    if (dispose !== undefined) scope.effect(() => dispose, "dsh-task-memory: panel routes");
  };
  if (typeof ctx.inject === "function") ctx.inject(["webServer"], mountPanel);
  else mountPanel(ctx);

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined && config.includeSystemPrompt) {
    // The standing instructions are global: they must be present in every session, including one
    // whose workspace has no cards yet.
    systemPrompt.section({
      name: "dsh-task-memory",
      order: systemPrompt.getSectionOrder("TOOL_SESSION_QUERY") - 1,
      text: workflowSection(),
    });
  }

  // The enforcement point. A prompt section can only ask the model to record what it learned, and a
  // model that just finished a task does not reliably act on one more instruction — so nothing was
  // recorded unless the user asked. Steering a review question at the turn's stop boundary is what
  // makes capture happen by default.
  const stopCapture = registerTurnCapture(ctx, config);
  if (stopCapture !== undefined) ctx.effect(() => stopCapture, "dsh-task-memory: turn capture");

  // The per-agent index. Registered on the agent's own scope so it can see that session's cwd, and
  // so unloading the plugin or disposing the agent removes it.
  if (typeof ctx.on === "function") {
    ctx.on("agent/created", async ({ agent }) => {
      const registry = agent?.ctx;
      if (registry === undefined) return;
      // Warm the cache before the section exists. `agent/created` listeners are awaited before the
      // first prompt assembly, so doing this first means the session's very first context already
      // carries the index rather than an empty section that fills in one step later.
      await refresh(resolveWorkspace(agent?.session?.header?.cwd)).catch(() => {});
      const dispose = registerIndexSection(agent, config, refresh);
      // Keep our own disposer too: unloading this plugin must not leave the registration behind.
      registry.effect?.(() => dispose, "dsh-task-memory: index section");
    });
  }
}

/** Exported for tests. */
export { deleteCard, refreshIndex, renderIndex, resolveStore, saveCard, THRESHOLDS };
