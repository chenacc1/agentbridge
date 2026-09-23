import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { SessionManager } from "../src/session-manager.js";
import { ConversationCatalog } from "../src/conversations/conversation-catalog.js";

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

test("session creation rejects an attach-only adapter before starting it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-only-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  let startCalled = false;
  const registry = new AdapterRegistry();
  registry.register({
    id: "attach-only",
    label: "Attach Only",
    capabilities: { create: false, attach: true },
    detect: async () => ({ available: true, supported: true }),
    async start() {
      startCalled = true;
      return { providerSessionId: "must-not-start" };
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });

  await assert.rejects(
    manager.create({
      adapterId: "attach-only",
      projectAlias: "demo",
      title: "Not allowed",
      commandId: "attach-only-create",
      device: { id: "device-a", deviceName: "A" },
    }),
    (error) => error.statusCode === 501 && error.code === "ADAPTER_CAPABILITY_UNSUPPORTED",
  );
  assert.equal(startCalled, false);
  assert.equal(manager.list().length, 0);
});

test("stop rejects unsupported adapters and sessions without an active turn", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-stop-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  let stopCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "no-cancel",
    label: "No Cancel",
    capabilities: { create: true, cancel: false },
    detect: async () => ({ available: true, supported: true }),
    start: async () => ({ providerSessionId: "no-cancel-provider" }),
    stop: async () => {
      stopCalls += 1;
      return true;
    },
  });
  registry.register(new EchoAdapter());
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  const device = { id: "device-a", deviceName: "A" };

  const unsupported = await manager.create({
    adapterId: "no-cancel",
    projectAlias: "demo",
    title: "Unsupported stop",
    commandId: "stop-create-unsupported",
    device,
  });
  await assert.rejects(
    manager.stop({ sessionId: unsupported.id, commandId: "stop-unsupported", device }),
    (error) => error.statusCode === 501 && error.code === "ADAPTER_CAPABILITY_UNSUPPORTED",
  );
  assert.equal(stopCalls, 0);

  const idle = await manager.create({
    adapterId: "echo",
    projectAlias: "demo",
    title: "Idle stop",
    commandId: "stop-create-idle",
    device,
  });
  await assert.rejects(
    manager.stop({ sessionId: idle.id, commandId: "stop-idle", device }),
    (error) => error.statusCode === 409 && /no active Agent turn/i.test(error.message),
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

test("persisted bridge sessions load offline and resume only when the user sends a message", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-session-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = new Map([["demo", directory]]);
  const catalogPath = path.join(directory, "bridge-sessions.json");
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  let resumeCalls = 0;
  const adapter = {
    id: "resumable-agent",
    label: "Resumable Agent",
    capabilities: { create: true, attach: true, resume: true },
    detect: async () => ({ available: true, supported: true }),
    start: async () => ({ providerSessionId: "provider-conversation-123" }),
    attach: async (context, providerSessionId) => {
      resumeCalls += 1;
      return { context, providerSessionId };
    },
    send: async (_handle, { emit }) => {
      await emit("turn.started", {}, { turnId: "resumed-turn" });
      await emit("turn.completed", { status: "completed" }, { turnId: "resumed-turn" });
    },
  };
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const firstCatalog = new ConversationCatalog({ filePath: catalogPath });
  await firstCatalog.init();
  const firstManager = new SessionManager({ eventStore, registry, projects, conversationCatalog: firstCatalog });
  const device = { id: "device-a", deviceName: "A" };
  const created = await firstManager.create({
    adapterId: adapter.id,
    projectAlias: "demo",
    title: "Survives restart",
    commandId: "persistent-create",
    device,
  });

  const reloadedCatalog = new ConversationCatalog({ filePath: catalogPath });
  await reloadedCatalog.init();
  const reloadedManager = new SessionManager({ eventStore, registry, projects, conversationCatalog: reloadedCatalog });
  const restored = reloadedManager.list()[0];

  assert.equal(restored.id, created.id);
  assert.equal(restored.providerSessionId, "provider-conversation-123");
  assert.equal(restored.status, "offline");
  assert.equal(resumeCalls, 0, "startup must not eagerly connect provider sessions");

  const completed = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind === "turn.completed" && event.sessionId === restored.id) {
        unsubscribe();
        resolve();
      }
    });
  });
  await reloadedManager.send({ sessionId: restored.id, text: "continue", commandId: "persistent-send", device });
  await completed;
  assert.equal(resumeCalls, 1);
  assert.equal(reloadedManager.list()[0].status, "ready");
});

test("provider discovery merges workspace conversations idempotently without resuming them", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const conversationCatalog = new ConversationCatalog({ filePath: path.join(directory, "bridge-sessions.json") });
  await conversationCatalog.init();
  const workspace = { id: "ws_demo", alias: "demo", canonicalPath: directory, enabled: true };
  const workspaceCatalog = { get: (identifier) => ([workspace.id, workspace.alias].includes(identifier) ? workspace : null) };
  let discoveryCalls = 0;
  let attachCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "discoverable-agent",
    label: "Discoverable Agent",
    capabilities: { create: false, attach: true, discover: true, resume: true },
    detect: async () => ({ available: true, supported: true }),
    discoverConversations: async ({ workspace: selected }) => {
      discoveryCalls += 1;
      assert.equal(selected.id, workspace.id);
      return {
        conversations: [{
          providerConversationId: "provider-thread-123",
          title: "Discovered thread",
          createdAt: "2026-09-20T00:00:00.000Z",
          lastActiveAt: "2026-09-23T12:00:00.000Z",
        }],
        diagnostics: { status: "available", protocol: "test/list", pages: 1 },
      };
    },
    attach: async (_context, providerSessionId) => {
      attachCalls += 1;
      return { providerSessionId };
    },
  });
  const manager = new SessionManager({
    eventStore,
    registry,
    projects: new Map([[workspace.alias, directory]]),
    conversationCatalog,
    workspaceCatalog,
  });

  const first = await manager.discover({ workspaceId: workspace.id, adapterId: "discoverable-agent" });
  const revision = conversationCatalog.revision;
  const second = await manager.discover({ workspaceId: workspace.id, adapterId: "discoverable-agent" });

  assert.equal(discoveryCalls, 2);
  assert.equal(attachCalls, 0, "listing provider threads must stay lazy");
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(conversationCatalog.revision, revision, "unchanged discovery must not rewrite the catalog");
  assert.equal(first.items[0].id, second.items[0].id);
  assert.equal(first.items[0].workspaceId, workspace.id);
  assert.equal(first.items[0].status, "offline");
  assert.equal(first.items[0].lastActiveAt, "2026-09-23T12:00:00.000Z");
  assert.equal(conversationCatalog.findByProvider("discoverable-agent", "provider-thread-123").origin, "provider-discovered");
  assert.deepEqual(manager.list({ workspaceId: workspace.id, adapterId: "discoverable-agent" }), second.items);
  assert.equal(eventStore.listAfter(0).filter((event) => event.kind === "conversation.discovered").length, 1);
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

// One request per token is far too many for a phone on a tunnel, and it let
// token chatter push real messages out of the event window. Deltas are coalesced
// per turn and addressed by character offset so a client can fold them safely.
test("streamed deltas are coalesced per turn and ordered before the committed message", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-deltas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  let fullText = "";
  registry.register({
    id: "chatter",
    label: "Chatter",
    capabilities: {},
    async detect() { return { available: true }; },
    async start() { return { providerSessionId: "chatter-1" }; },
    async send(_handle, { emit }) {
      const turnId = "turn-1";
      await emit("turn.started", { adapter: "chatter" }, { turnId });
      for (let index = 1; index <= 1200; index += 1) {
        const piece = `w${index} `;
        fullText += piece;
        await emit("message.delta", { role: "assistant", text: piece }, { turnId });
      }
      await emit("message.completed", { role: "assistant", text: fullText }, { turnId });
      await emit("turn.completed", { status: "completed" }, { turnId });
    },
  });
  const manager = new SessionManager({
    eventStore,
    registry,
    projects: new Map([["demo", directory]]),
    deltaFlushMs: 5,
  });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "chatter", projectAlias: "demo", title: "Chatter", commandId: "chatter-create", device });
  const done = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind === "turn.completed") {
        unsubscribe();
        resolve();
      }
    });
  });
  await manager.send({ sessionId: session.id, text: "go", commandId: "chatter-send", device });
  await done;

  const events = eventStore.listAfter(0, { sessionId: session.id });
  const kinds = events.map((event) => event.kind);
  const deltas = events.filter((event) => event.kind === "message.delta");
  const committed = events.filter((event) => event.kind === "message.completed" && event.payload.role === "assistant");

  assert.equal(committed.length, 1);
  assert.ok(deltas.length > 0, "no coalesced delta was emitted at all");
  assert.ok(deltas.length < 60, `1200 tokens still produced ${deltas.length} delta events`);

  // Every delta must precede the committed assistant message, and the offsets
  // must form a gapless chain a client can fold into the full reply.
  const committedIndex = events.findIndex((event) => event.kind === "message.completed" && event.payload.role === "assistant");
  assert.ok(committedIndex >= 0);
  assert.ok(kinds.lastIndexOf("message.delta") < committedIndex, "a delta was stored after the committed message");
  let cursor = 0;
  let folded = "";
  for (const delta of deltas) {
    assert.equal(delta.payload.offset, cursor, "delta offsets are not contiguous");
    folded += delta.payload.text;
    cursor += delta.payload.text.length;
  }
  assert.equal(folded, fullText, "the coalesced deltas do not rebuild the streamed reply");
  assert.equal(committed[0].payload.text, fullText);
});

test("a new turn starts a fresh delta chain", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-deltas-turn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  let attempt = 0;
  registry.register({
    id: "two-turns",
    label: "Two turns",
    capabilities: {},
    async detect() { return { available: true }; },
    async start() { return { providerSessionId: "two-turns-1" }; },
    async send(_handle, { emit }) {
      attempt += 1;
      const turnId = `turn-${attempt}`;
      await emit("turn.started", { adapter: "two-turns" }, { turnId });
      await emit("message.delta", { role: "assistant", text: "hello" }, { turnId });
      await emit("message.delta", { role: "assistant", text: " again" }, { turnId });
      await emit("message.completed", { role: "assistant", text: "hello again" }, { turnId });
      await emit("turn.completed", { status: "completed" }, { turnId });
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]), deltaFlushMs: 5 });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "two-turns", projectAlias: "demo", title: "Two", commandId: "two-create", device });
  for (const [index, commandId] of ["two-send-1", "two-send-2"].entries()) {
    const done = new Promise((resolve) => {
      const unsubscribe = eventStore.subscribe((event) => {
        if (event.kind === "turn.completed" && event.turnId === `turn-${index + 1}`) {
          unsubscribe();
          resolve();
        }
      });
    });
    await manager.send({ sessionId: session.id, text: `go ${index}`, commandId, device });
    await done;
  }

  const deltas = eventStore.listAfter(0, { sessionId: session.id }).filter((event) => event.kind === "message.delta");
  assert.equal(deltas.length, 2, "each turn must keep its own delta chain");
  assert.deepEqual(deltas.map((delta) => delta.payload.offset), [0, 0]);
  assert.deepEqual(deltas.map((delta) => delta.payload.text), ["hello again", "hello again"]);
});
