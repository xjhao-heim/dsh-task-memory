/**
 * Turn-end memory capture.
 *
 * Why this exists: a prompt section can only *ask* the model to save what it learned, and a model
 * that has just finished a task does not reliably act on one more instruction. The result was a
 * memory that only filled up when the user explicitly said "remember this" — exactly the behaviour
 * this plugin was built to remove.
 *
 * The enforcement point is `agent/turn-stopping`: the harness awaits it before a turn closes, and a
 * listener that calls `agent.steer(...)` makes the machine re-read its inbox and run one more step.
 * That is a real trigger, not a request.
 *
 * It steers a *question*, not a write. The extra step asks the model to judge this turn against the
 * criteria already stated in the prompt section and to call `task_memory_save` only when the turn
 * produced something durable. The judgement stays with the model — only it can tell a reusable root
 * cause from a one-off lookup — but the reminder now fires on its own.
 *
 * Loop safety is the load-bearing property. It rests on two independent facts:
 *
 *   1. The reminder opens a turn that makes no tool calls, so it can never earn another reminder.
 *   2. A turn that already saved a card is never reminded, because the work is already done.
 *
 * @module dsh-task-memory/capture
 */

import { randomUUID } from "node:crypto";

/** Source tag carried by the reminder, so the same turn is never reminded twice. */
const REMINDER_SOURCE = "task-memory-capture";

/** Tool calls a turn must make before its work is worth reviewing. Below this it is a lookup. */
const MIN_TOOL_CALLS = 3;

/** The save tool, whose presence in a turn means there is nothing left to remind about. */
const SAVE_TOOL = "task_memory_save";

/**
 * Build a user message without importing `@deepseek-ai/dsh-llm`.
 *
 * The plugin is installed by junction, so its real path cannot reach the host's packages. The shape
 * below is the documented one: a stable id, a `role`, model-facing content blocks, and a producer
 * source. The source kind is deliberately plugin-owned — `MessageSourceMap` is merge-extensible and
 * consumers fall through unknown kinds.
 *
 * @param text - reminder text.
 * @returns a frozen user message.
 */
function reminderMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    source: Object.freeze({ kind: REMINDER_SOURCE, form: "instructions" }),
  });
}

/** The reminder body. Short on purpose: it rides inside the conversation, not the system prompt. */
const REMINDER_TEXT = [
  "任务记忆自动检查：本轮工作已结束。回顾本轮，判断是否产生了值得留存的东西：",
  "",
  "- 排查出根因，或试错后找到正确做法 → 值得存；",
  "- 形成了可复用的步骤、命令、配置或接口用法 → 值得存；",
  "- 踩到不明显的坑，值得下次避开 → 值得存；",
  "- 只是查询、读取，或没有非显然结论的小改动 → 不值得存。",
  "",
  "值得存时调 `task_memory_save`：先 `task_memory_index` 看是否已有同一件事的卡——",
  "有就给 `task_memory_save` 传 `mode: \"update\"` 更新那一张，没有才新建。",
  "只写本轮新出现的结论，不要复述已有的卡。",
  "不值得存时：直接回复「本轮无需记录」，不要为了应付检查而制造卡片。",
].join("\n");

/**
 * Snapshot a session's events, tolerating a host without a readable log.
 *
 * `snapshotEvents()` is the documented reader. The fallback keeps every check total, so a missing log
 * reads as "nothing to see" instead of throwing inside the turn-end hook.
 *
 * @param agent - the agent whose turn is ending.
 * @returns the events, or an empty array.
 */
function eventsOf(agent) {
  const session = agent?.session;
  if (session === undefined || session === null) return [];
  if (typeof session.snapshotEvents !== "function") return [];
  try {
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * Inspect one turn: how much it did, whether it already saved, and whether it was itself a review.
 *
 * Read from the durable session log rather than a live counter — the log is the source of truth for
 * what happened, and this needs no state a resumed session would lose.
 *
 * The `user/message` event carries no turn number, so events before this turn's `turn/start` are
 * skipped: otherwise a reminder from an earlier turn would permanently silence every later one.
 *
 * @param agent - the agent whose turn is ending.
 * @param turn - the turn number.
 * @returns the tool-call count, whether a card was saved, and whether this turn carries a reminder.
 */
function inspectTurn(agent, turn) {
  let toolCalls = 0;
  let saved = false;
  let reminded = false;
  let inTurn = false;
  for (const event of eventsOf(agent)) {
    if (event?.type === "turn/start") {
      inTurn = event.data?.turn === turn;
      continue;
    }
    if (!inTurn) continue;
    if (event.type === "tool/result") {
      toolCalls += 1;
      if (event.data?.message?.name === SAVE_TOOL) saved = true;
    }
    // `user/message` carries the message as its own payload, not under a `message` key.
    if (event.type === "user/message" && event.data?.source?.kind === REMINDER_SOURCE) reminded = true;
  }
  return { toolCalls, saved, reminded };
}

/**
 * Install the turn-end reminder.
 *
 * @param ctx - the plugin context.
 * @param config - resolved config.
 * @returns a disposer, or undefined when the host has no event registry.
 */
export function registerTurnCapture(ctx, config) {
  if (typeof ctx?.on !== "function") return undefined;

  ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
    if (config.autoCapture === false) return;
    if (agent === undefined || agent === null) return;
    if (typeof agent.steer !== "function") return;

    // A child agent (a subagent) has its own workflow; reminding it would spend a step on
    // bookkeeping the parent session does not own.
    if (agent.parent !== undefined) return;

    const { toolCalls, saved, reminded } = inspectTurn(agent, turn);

    // Nothing was done: a lookup, a chat reply, or the reminder's own review step. Never remind.
    if (toolCalls < MIN_TOOL_CALLS) return;
    // The turn already recorded something, so the memory is up to date.
    if (saved) return;
    // This turn is the review step itself, or the answer to one. Asking again would loop.
    if (reminded) return;

    try {
      agent.steer(reminderMessage(REMINDER_TEXT));
    } catch {
      // A refused steer must not fail the turn-end hook; the turn simply closes without a reminder.
    }
  });

  return () => {};
}

/** Exported for tests. */
export { REMINDER_SOURCE, REMINDER_TEXT, MIN_TOOL_CALLS, SAVE_TOOL, reminderMessage };
