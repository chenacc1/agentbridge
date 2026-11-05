import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";

// The bug these tests pin down: `send` marks a session running before the Agent has
// been asked to do anything, and only an event from that Agent clears the mark. A
// desktop app that was restarted, a conversation that no longer exists, or a cancel
// nobody answers all produced the same shape — a session stuck in 执行中 where the
// phone disabled its own composer, the stop button asked a ghost to stop, and the
// safe shutdown refused to run because the session still looked busy.

async function fixture(t, { acknowledge = false, cancel = "ignore", turnAckMs = 60_000, stopAckMs = 60_000 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-watchdog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const state = { emit: null, sends: 0, stops: 0 };
  registry.register({
    id: "watchdog-fixture",
    label: "Watchdog Fixture",
    capabilities: { create: true, cancel: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) {
      state.emit = context.emit;
      return { providerSessionId: "watchdog-fixture-session" };
    },
    async send(handle, payload) {
      state.sends += 1;
      state.emit = payload.emit;
      if (acknowledge) await payload.emit("turn.started", {}, { turnId: "turn-ack" });
      // A real Agent that never answers simply never calls emit.
    },
    async stop() {
      state.stops += 1;
      if (cancel === "throw") throw Object.assign(new Error("桌面端这个会话没有在响应"), { statusCode: 409 });
      return true;
    },
  });
  const manager = new SessionManager({
    eventStore,
    registry,
    projects: new Map([["demo", directory]]),
    turnAckMs,
    stopAckMs,
  });
  const device = { id: "phone-a", deviceName: "Phone" };
  const session = await manager.create({
    adapterId: "watchdog-fixture",
    projectAlias: "demo",
    title: "看门狗",
    commandId: "watchdog-create-1",
    device,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const history = async () => {
    const page = await eventStore.readSessionHistory(session.id, { limit: 200 });
    return page.events.map((event) => ({ kind: event.kind, payload: event.payload }));
  };
  return { manager, eventStore, state, device, session, history };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a dispatch no Agent ever acknowledges releases the phone instead of hanging in 执行中", async (t) => {
  const { manager, session, history, state } = await fixture(t, { turnAckMs: 60 });

  await manager.send({ sessionId: session.id, text: "开始吧", commandId: "watchdog-send-1", device: { id: "phone-a", deviceName: "Phone" } });
  await sleep(20);
  assert.equal(manager.list().find((entry) => entry.id === session.id).status, "running");

  await sleep(180);
  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.equal(listed.status, "failed", "a turn that never started must not stay running");
  assert.match(listed.lastError ?? "", /没有开始执行/);

  const failures = (await history()).filter((event) => event.kind === "turn.failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].payload.code, "TURN_ACK_TIMEOUT");

  // The input is usable again: a second message is dispatched rather than queued.
  const second = await manager.send({ sessionId: session.id, text: "再试一次", commandId: "watchdog-send-2", device: { id: "phone-a", deviceName: "Phone" } });
  assert.equal(second.accepted, true);
  assert.equal(second.queued, undefined);
  // Close the turn out so its own (short) acknowledgement window does not fire after
  // the fixture's temporary directory is gone.
  await state.emit("turn.completed", {});
});

test("an Agent that starts its turn is never failed by the watchdog", async (t) => {
  const { manager, session, history } = await fixture(t, { acknowledge: true });
  await manager.send({ sessionId: session.id, text: "开始吧", commandId: "watchdog-send-3", device: { id: "phone-a", deviceName: "Phone" } });

  await sleep(180);
  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.equal(listed.status, "running", "a live turn may outlast the acknowledgement window");
  assert.equal((await history()).filter((event) => event.kind === "turn.failed").length, 0);

  // Hard stop for a later test file cleanup: let the fixture settle.
  await manager.stop({ sessionId: session.id, commandId: "watchdog-stop-cleanup", device: { id: "phone-a", deviceName: "Phone" } });
});

test("a delivered stop shows 停止中 and clears when the Agent echoes its turn end", async (t) => {
  const { manager, state, session } = await fixture(t);
  const device = { id: "phone-a", deviceName: "Phone" };
  await manager.send({ sessionId: session.id, text: "长任务", commandId: "watchdog-send-4", device });
  await sleep(20);

  const result = await manager.stop({ sessionId: session.id, commandId: "watchdog-stop-1", device });
  assert.deepEqual(result, { stopped: true });
  assert.equal(manager.list().find((entry) => entry.id === session.id).status, "stopping");

  await state.emit("turn.cancelled", { reason: { kind: "cancelled" } }, { turnId: "turn-ack" });
  await sleep(20);
  assert.equal(manager.list().find((entry) => entry.id === session.id).status, "ready");
});

test("a stop the Agent never answers is ended by the bridge, with the reason on the record", async (t) => {
  const { manager, session, history } = await fixture(t, { stopAckMs: 60 });
  const device = { id: "phone-a", deviceName: "Phone" };
  await manager.send({ sessionId: session.id, text: "停不下来的一轮", commandId: "watchdog-send-5", device });
  await sleep(20);
  await manager.stop({ sessionId: session.id, commandId: "watchdog-stop-2", device });

  await sleep(200);
  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.equal(listed.status, "ready", "an unanswered stop must still free the phone");
  const forced = (await history()).filter((event) => event.kind === "turn.cancelled");
  assert.equal(forced.length, 1);
  assert.equal(forced[0].payload.reason.kind, "forced");
  assert.match(forced[0].payload.reason.note, /没有回应停止请求/);
});

test("a stop that cannot even be delivered ends the turn locally and says so", async (t) => {
  const { manager, session, history } = await fixture(t, { cancel: "throw" });
  const device = { id: "phone-a", deviceName: "Phone" };
  await manager.send({ sessionId: session.id, text: "桌面端已经关了", commandId: "watchdog-send-6", device });
  await sleep(20);

  const result = await manager.stop({ sessionId: session.id, commandId: "watchdog-stop-3", device });
  assert.deepEqual(result, { stopped: false, forced: true });

  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.equal(listed.status, "ready");
  const events = await history();
  const requested = events.filter((event) => event.kind === "turn.stop_requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].payload.delivered, false);
  assert.equal(events.filter((event) => event.kind === "turn.cancelled").length, 1);
});

test("a message typed while the turn is being stopped is queued, not refused", async (t) => {
  const { manager, session } = await fixture(t);
  const device = { id: "phone-a", deviceName: "Phone" };
  await manager.send({ sessionId: session.id, text: "第一轮", commandId: "watchdog-send-7", device });
  await sleep(20);
  await manager.stop({ sessionId: session.id, commandId: "watchdog-stop-4", device });

  const queued = await manager.send({ sessionId: session.id, text: "停止后再发", commandId: "watchdog-send-8", device });
  assert.equal(queued.queued, true);
  assert.equal(manager.list().find((entry) => entry.id === session.id).queued.length, 1);
});
