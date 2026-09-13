import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { SessionManager } from "../src/session-manager.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-manager-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  registry.register(new EchoAdapter());
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  return { eventStore, manager };
}

test("session creation is idempotent and rejects unknown project paths", async (t) => {
  const { manager } = await fixture(t);
  const device = { id: "device-a", deviceName: "A" };
  const input = { adapterId: "echo", projectAlias: "demo", title: "Demo", commandId: "command-create-1", device };
  const first = await manager.create(input);
  const second = await manager.create(input);
  assert.equal(first.id, second.id);
  await assert.rejects(
    manager.create({ ...input, projectAlias: "C:\\", commandId: "command-create-2" }),
    /not allowed/,
  );
});

test("control lease prevents a second device from sending implicitly", async (t) => {
  const { eventStore, manager } = await fixture(t);
  const owner = { id: "device-a", deviceName: "A" };
  const other = { id: "device-b", deviceName: "B" };
  const session = await manager.create({ adapterId: "echo", projectAlias: "demo", title: "Demo", commandId: "command-create-3", device: owner });
  await assert.rejects(
    manager.send({ sessionId: session.id, text: "hello", commandId: "command-send-1", device: other }),
    /Take control first/,
  );
  await manager.claimControl({ sessionId: session.id, commandId: "command-control-1", device: other, force: true });
  const completed = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind === "turn.completed") {
        unsubscribe();
        resolve();
      }
    });
  });
  const result = await manager.send({ sessionId: session.id, text: "hello", commandId: "command-send-2", device: other });
  assert.equal(result.accepted, true);
  await completed;
});

test("attaching an existing provider conversation reuses the same bridge session", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  registry.register({
    id: "attached-agent",
    label: "Attached Agent",
    capabilities: { resume: true },
    detect: async () => ({ available: true }),
    attach: async (context, providerSessionId) => ({ context, providerSessionId }),
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["attached", directory]]) });
  const device = { id: "local-launcher", deviceName: "Local launcher" };
  const input = {
    adapterId: "attached-agent",
    projectAlias: "attached",
    providerSessionId: "provider-session-123",
    title: "Existing conversation",
    commandId: "attach-command-one",
    device,
  };

  const first = await manager.attach(input);
  const second = await manager.attach({ ...input, commandId: "attach-command-two" });

  assert.equal(first.id, second.id);
  assert.equal(first.providerSessionId, "provider-session-123");
  assert.equal(manager.list().length, 1);
});

test("concurrent agent sessions keep independent provider handles and controller leases", async (t) => {
  const { manager } = await fixture(t);
  const deviceA = { id: "device-a", deviceName: "A" };
  const deviceB = { id: "device-b", deviceName: "B" };
  const [first, second] = await Promise.all([
    manager.create({ adapterId: "echo", projectAlias: "demo", title: "A", commandId: "concurrent-create-a", device: deviceA }),
    manager.create({ adapterId: "echo", projectAlias: "demo", title: "B", commandId: "concurrent-create-b", device: deviceB }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.providerSessionId, second.providerSessionId);
  assert.equal(first.controller.deviceId, deviceA.id);
  assert.equal(second.controller.deviceId, deviceB.id);
});

test("turn failures remain visible in the session summary and clear on retry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-failure-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  let attempt = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "failure-agent",
    label: "Failure Agent",
    capabilities: {},
    detect: async () => ({ available: true }),
    start: async (context) => ({ context, providerSessionId: "failure-provider" }),
    send: async (_handle, { emit }) => {
      attempt += 1;
      await emit("turn.started", { adapter: "failure-agent" }, { turnId: `turn-${attempt}` });
      if (attempt === 1) await emit("turn.failed", { error: "model rejected" }, { turnId: `turn-${attempt}` });
      else await emit("turn.completed", { status: "completed" }, { turnId: `turn-${attempt}` });
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["failure", directory]]) });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "failure-agent", projectAlias: "failure", title: "Failure", commandId: "failure-create", device });
  const waitFor = (kind) => new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
      }
    });
  });

  let terminal = waitFor("turn.failed");
  await manager.send({ sessionId: session.id, text: "first", commandId: "failure-send-1", device });
  await terminal;
  assert.equal(manager.list().find((item) => item.id === session.id)?.lastError, "model rejected");

  terminal = waitFor("turn.completed");
  await manager.send({ sessionId: session.id, text: "second", commandId: "failure-send-2", device });
  await terminal;
  assert.equal(manager.list().find((item) => item.id === session.id)?.lastError, null);
});
