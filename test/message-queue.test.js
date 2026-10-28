import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const state = { emit: null, sent: [], finish: null };
  registry.register({
    id: "queue-fixture",
    label: "Queue Fixture",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) {
      state.emit = context.emit;
      return { providerSessionId: "queue-fixture-session" };
    },
    async send(_handle, payload) {
      state.sent.push(payload);
      state.finish = () => payload.emit("turn.completed", { status: "end_turn" });
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  const device = { id: "phone-a", deviceName: "Phone" };
  const session = await manager.create({ adapterId: "queue-fixture", projectAlias: "demo", title: "排队", commandId: "queue-create-1", device });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { manager, eventStore, state, device, session };
}

test("a message sent while the agent is busy is queued, not rejected", async (t) => {
  const { manager, state, device, session } = await fixture(t);

  await manager.send({ sessionId: session.id, text: "第一条", commandId: "queue-send-1", device });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await manager.send({ sessionId: session.id, text: "第二条", commandId: "queue-send-2", device });

  assert.equal(second.queued, true);
  assert.equal(second.position, 1);
  assert.deepEqual(state.sent.map((payload) => payload.text), ["第一条"], "the queued message must not be dispatched yet");
  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.equal(listed.queued.length, 1);
  assert.equal(listed.queued[0].text, "第二条");

  // Finishing the turn releases the queue.
  state.finish();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(state.sent.map((payload) => payload.text), ["第一条", "第二条"]);
  assert.equal(manager.list().find((entry) => entry.id === session.id).queued.length, 0);
});

test("the queue is bounded and can be cancelled", async (t) => {
  const { manager, state, device, session } = await fixture(t);
  await manager.send({ sessionId: session.id, text: "运行中", commandId: "queue-send-3", device });
  await new Promise((resolve) => setTimeout(resolve, 20));

  for (let index = 0; index < 5; index += 1) {
    await manager.send({ sessionId: session.id, text: `排队 ${index}`, commandId: `queue-fill-${index}`, device });
  }
  await assert.rejects(
    manager.send({ sessionId: session.id, text: "第六条", commandId: "queue-fill-overflow", device }),
    /排队已满/,
  );

  const cancelled = await manager.cancelQueued({ sessionId: session.id, commandId: "queue-fill-0", device });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.remaining, 4);
  assert.equal(manager.list().find((entry) => entry.id === session.id).queued.length, 4);

  state.finish();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const sentTexts = state.sent.map((payload) => payload.text);
  assert.ok(!sentTexts.includes("排队 0"), "a cancelled message must never be sent");
  assert.ok(sentTexts.includes("排队 1"));
});

test("only the controlling device may cancel a queued message", async (t) => {
  const { manager, device, session } = await fixture(t);
  await manager.send({ sessionId: session.id, text: "运行中", commandId: "queue-send-4", device });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.send({ sessionId: session.id, text: "排队", commandId: "queue-send-5", device });
  await assert.rejects(
    manager.cancelQueued({ sessionId: session.id, commandId: "queue-send-5", device: { id: "other", deviceName: "Other" } }),
    /接管输入/,
  );
});
test("turns and tool calls are counted, and reported tokens are summed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const state = { emit: null };
  registry.register({
    id: "usage-fixture",
    label: "Usage Fixture",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) { state.emit = context.emit; return { providerSessionId: "usage-session" }; },
    async send() {},
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  const device = { id: "phone", deviceName: "Phone" };
  const session = await manager.create({ adapterId: "usage-fixture", projectAlias: "demo", title: "用量", commandId: "usage-create-1", device });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const usageOf = () => manager.list().find((entry) => entry.id === session.id).usage;
  assert.deepEqual(usageOf(), { turns: 0, toolCalls: 0 });

  await state.emit("turn.started", {});
  await state.emit("tool.started", { command: "npm test" });
  await state.emit("tool.started", { command: "npm run lint" });
  await state.emit("turn.completed", { status: "completed", usage: { inputTokens: 1200, outputTokens: 340 } });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const usage = usageOf();
  assert.equal(usage.turns, 1);
  assert.equal(usage.toolCalls, 2);
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 340);

  // A second turn adds to the totals instead of replacing them.
  await state.emit("turn.completed", { status: "completed", usage: { inputTokens: 800 } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(usageOf().turns, 2);
  assert.equal(usageOf().inputTokens, 2000);
  assert.equal(usageOf().outputTokens, 340);
});