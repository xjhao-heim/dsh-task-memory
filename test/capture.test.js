/**
 * Turn-end capture tests.
 *
 * The reminder is the plugin's enforcement point, so what matters here is *when it fires* and, above
 * all, that it cannot loop: a reminder opens a turn, and that turn's stop boundary fires the same
 * listener again. A bug here would either nag forever or never fire at all.
 *
 * The listener is driven through a fake host that records `ctx.on` handlers, with a fake agent whose
 * session log is a plain array — the two things the real listener reads.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_TOOL_CALLS,
  REMINDER_SOURCE,
  registerTurnCapture,
  reminderMessage,
} from "../lib/capture.js";

/**
 * Build a fake host capturing registered listeners.
 * @returns the context and a dispatcher.
 */
function host() {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  };
  return {
    ctx,
    async fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) await handler(payload);
    },
  };
}

/**
 * Build a fake agent whose session log is the supplied events.
 * @param events - session events.
 * @param extra - extra agent fields.
 * @returns the agent plus a record of steered messages.
 */
function agent(events, extra = {}) {
  const steered = [];
  return {
    steered,
    agent: {
      session: { snapshotEvents: () => events },
      steer: (message) => steered.push(message),
      ...extra,
    },
  };
}

/** One turn's worth of events: a start marker plus `count` tool results. */
function turnEvents(turn, count, options = {}) {
  const events = [{ type: "turn/start", data: { turn } }];
  for (let index = 0; index < count; index += 1) {
    events.push({ type: "tool/result", data: { turn, step: index + 1, message: { name: options.tool ?? "read" } } });
  }
  if (options.reminder === true) {
    events.push({ type: "user/message", data: { id: "r", role: "user", content: [], source: { kind: REMINDER_SOURCE } } });
  }
  return events;
}

test("a substantial turn is reminded at its stop boundary", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const { agent: fake, steered } = agent(turnEvents(1, MIN_TOOL_CALLS));

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 1, "the review question must be steered");
  assert.equal(steered[0].source.kind, REMINDER_SOURCE);
  assert.equal(steered[0].role, "user");
  assert.match(steered[0].content[0].text, /task_memory_save/);
});

test("a short turn is not reminded", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const { agent: fake, steered } = agent(turnEvents(1, MIN_TOOL_CALLS - 1));

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 0, "a lookup is not worth a review step");
});

test("a turn that already saved a card is not reminded", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const { agent: fake, steered } = agent(turnEvents(1, 5, { tool: "task_memory_save" }));

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 0, "the memory is already up to date");
});

test("the reminder's own turn never earns another reminder", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });

  // Turn 1 does real work and is reminded.
  const events = turnEvents(1, 4);
  const { agent: fake, steered } = agent(events);
  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 1);

  // The reminder opens turn 2, which the model answers with a short reply and no tool calls.
  events.push({ type: "turn/end", data: { turn: 1 } });
  events.push({ type: "user/message", data: { id: "r", role: "user", content: [], source: { kind: REMINDER_SOURCE } } });
  events.push(...turnEvents(2, 0));
  await fire("agent/turn-stopping", { agent: fake, turn: 2 });
  assert.equal(steered.length, 1, "the review step must not trigger another review");
});

test("the review turn is recognised even when it does make tool calls", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });

  // Turn 1 earns a reminder.
  const events = turnEvents(1, 4);
  const { agent: fake, steered } = agent(events);
  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 1);

  // Asked to review, the model checks the index and saves nothing (a lookup, then a decision). That
  // is still >= MIN_TOOL_CALLS, so only the reminder marker can stop a second reminder.
  events.push({ type: "turn/end", data: { turn: 1 } });
  events.push({ type: "turn/start", data: { turn: 2 } });
  events.push({ type: "user/message", data: { id: "r", role: "user", content: [], source: { kind: REMINDER_SOURCE } } });
  events.push({ type: "tool/result", data: { turn: 2, step: 1, message: { name: "task_memory_index" } } });
  events.push({ type: "tool/result", data: { turn: 2, step: 1, message: { name: "read" } } });
  events.push({ type: "tool/result", data: { turn: 2, step: 1, message: { name: "grep" } } });

  await fire("agent/turn-stopping", { agent: fake, turn: 2 });
  assert.equal(steered.length, 1, "a review turn must not be reviewed again");
});

test("a later turn in the same session can be reminded again", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const events = turnEvents(1, 4);
  const { agent: fake, steered } = agent(events);

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 1);

  // The user declines to record, then starts unrelated substantial work in a new turn.
  events.push({ type: "turn/end", data: { turn: 1 } });
  events.push({ type: "user/message", data: { id: "r", role: "user", content: [], source: { kind: REMINDER_SOURCE } } });
  events.push({ type: "turn/end", data: { turn: 2 } });
  events.push({ type: "user/message", data: { id: "u", role: "user", content: [], source: { kind: "user" } } });
  events.push(...turnEvents(3, 5));

  await fire("agent/turn-stopping", { agent: fake, turn: 3 });
  assert.equal(steered.length, 2, "new substantial work deserves its own review");
});

test("a subagent is never reminded", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const { agent: fake, steered } = agent(turnEvents(1, 6), { parent: { id: "parent" } });

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 0, "a child agent's workflow is not the session's to record");
});

test("disabling autoCapture stops the reminder", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: false });
  const { agent: fake, steered } = agent(turnEvents(1, 6));

  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
  assert.equal(steered.length, 0);
});

test("a host without a readable log fails safe in both directions", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });

  // No snapshotEvents at all: the tool count reads as zero, so nothing is steered. Never throw.
  const bare = { session: {}, steer: () => { throw new Error("must not be called"); } };
  await fire("agent/turn-stopping", { agent: bare, turn: 1 });

  // A reader that throws must not take the turn-end hook down with it.
  const throwing = { session: { snapshotEvents() { throw new Error("log unavailable"); } }, steer: () => {} };
  await fire("agent/turn-stopping", { agent: throwing, turn: 1 });
});

test("a refused steer does not fail the turn-end hook", async () => {
  const { ctx, fire } = host();
  registerTurnCapture(ctx, { autoCapture: true });
  const fake = {
    session: { snapshotEvents: () => turnEvents(1, 5) },
    steer: () => { throw new Error("steering refused"); },
  };
  await fire("agent/turn-stopping", { agent: fake, turn: 1 });
});

test("registering returns a disposer, and a host with no event registry is tolerated", () => {
  const { ctx } = host();
  assert.equal(typeof registerTurnCapture(ctx, {}), "function");
  assert.equal(registerTurnCapture({}, {}), undefined);
});

test("the reminder is a frozen, well-formed user message", () => {
  const message = reminderMessage("正文");
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, REMINDER_SOURCE);
  assert.equal(message.content[0].type, "text");
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0, "a stable identity is required");
  assert.ok(Object.isFrozen(message), "the host freezes messages; ours must not be mutable");
});
