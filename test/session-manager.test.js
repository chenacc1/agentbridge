import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
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
    /接管输入/,
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

// A DSH Desktop conversation is only drivable while its companion channel is connected.
// The phone needs that as a fact on the session, so it can say "run /phone on the desktop"
// instead of opening an input box that fails on the first send.
test("a desktop-attached session reports whether its companion is connected", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-desktop-online-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const online = new Set(["dsh-companion-1"]);
  const registry = new AdapterRegistry();
  registry.register(new EchoAdapter());
  registry.register({
    id: "deepseek-harness-desktop",
    label: "DSH Desktop",
    capabilities: { resume: true },
    detect: async () => ({ available: true }),
    channels: { isOnline: (providerSessionId) => online.has(providerSessionId) },
    attach: async (context, providerSessionId) => ({ providerSessionId, emit: context.emit }),
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["desktop", directory]]) });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.attach({
    adapterId: "deepseek-harness-desktop",
    projectAlias: "desktop",
    providerSessionId: "dsh-companion-1",
    title: "桌面会话",
    commandId: "desktop-attach-1",
    device,
  });
  assert.equal(session.desktopConnected, true, "a live companion channel means the phone can drive it");

  // The bridge forgot the channel (a restart): the session is still listed, but nothing
  // can be sent into it until the desktop side reconnects.
  online.clear();
  assert.equal(manager.list().find((item) => item.id === session.id).desktopConnected, false);

  // Every other adapter owns its own process, so the question does not apply to them.
  const echo = await manager.create({ adapterId: "echo", projectAlias: "desktop", title: "Echo", commandId: "echo-command-1", device });
  assert.equal(manager.list().find((item) => item.id === echo.id).desktopConnected, null);
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

// An adapter emits through a closure it does not await, so an event that cannot be
// logged must not become an unhandled rejection: one unwritable log line used to be
// able to kill a bridge that was happily serving every other conversation.
test("an event the log cannot record is reported, not thrown back at the adapter", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-log-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failWrites = false;
  const eventStore = new EventStore({
    filePath: path.join(directory, "events.jsonl"),
    appendFileImpl: async (...args) => {
      if (failWrites) throw Object.assign(new Error("disk is gone"), { code: "ENOENT" });
      return appendFile(...args);
    },
  });
  await eventStore.init();
  const registry = new AdapterRegistry();
  let adapterEmit = null;
  registry.register({
    id: "log-failure",
    label: "Log Failure",
    capabilities: {},
    detect: async () => ({ available: true }),
    start: async () => ({ providerSessionId: "log-failure-1" }),
    // The real adapters keep this closure and call it later, without awaiting it.
    send: async (_handle, { emit }) => {
      adapterEmit = emit;
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "log-failure", projectAlias: "demo", title: "Log", commandId: "log-create", device });
  await manager.send({ sessionId: session.id, text: "hello", commandId: "log-send", device });

  const reported = [];
  const originalError = console.error;
  console.error = (...args) => reported.push(args.join(" "));
  t.after(() => { console.error = originalError; });
  failWrites = true;

  // Fire and forget, exactly like the adapters: this must resolve quietly, not reject.
  adapterEmit("turn.completed", { status: "completed" }, { turnId: "turn-1" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(reported.some((line) => line.includes("dropped turn.completed")), `expected a reported drop, saw ${JSON.stringify(reported)}`);
  // The in-memory session still moved on — the drop is a durability loss, not a state
  // one — but nothing was written, and that is what the phone would have replayed.
  const logged = async () => (await readFile(path.join(directory, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).kind);
  assert.equal(manager.list().find((item) => item.id === session.id)?.status, "ready");
  assert.ok(!(await logged()).includes("turn.completed"), "the failed write must not appear in the log");
  // The chain recovers on the next write, so a transient outage is not permanent.
  failWrites = false;
  await adapterEmit("turn.completed", { status: "completed" }, { turnId: "turn-1" });
  assert.ok((await logged()).includes("turn.completed"), "the next write must land");
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

// A question is a different barrier from a stop request: the turn keeps running
// while it waits, so the phone must be able to answer it back into the same run.
test("a pending question is answered through the adapter and reported once", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-question-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const answered = [];
  registry.register({
    id: "asks",
    label: "Asks",
    capabilities: { create: true, answer: true },
    async detect() { return { available: true }; },
    async start() { return { providerSessionId: "asks-1" }; },
    async send(_handle, { emit }) {
      await emit("turn.started", { adapter: "asks" }, { turnId: "ask-turn" });
      await emit("input.requested", {
        requestId: "question-1",
        adapter: "asks",
        questions: [{ id: "mode", question: "Which storage?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
      }, { turnId: "ask-turn" });
    },
    async resolveInput(_handle, requestId, payload) {
      answered.push({ requestId, ...payload });
      return true;
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]), deltaFlushMs: 5 });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "asks", projectAlias: "demo", title: "Asks", commandId: "asks-create", device });
  // `send` drives the adapter in the background, so the question is awaited
  // through the store instead of being read back immediately after the call.
  const requested = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind !== "input.requested") return;
      unsubscribe();
      resolve(event);
    });
  });
  await manager.send({ sessionId: session.id, text: "go", commandId: "asks-send-1", device });
  assert.ok(await requested, "the question was never published to the phone");

  await assert.rejects(
    manager.resolveInput({ requestId: "question-1", answers: [{ id: "mode", selected: ["MySQL"] }], commandId: "asks-answer-bad", device }),
    (error) => error.statusCode === 400 && error.code === "INPUT_ANSWER_INVALID",
  );
  await assert.rejects(
    manager.resolveInput({ requestId: "question-1", answers: [{ id: "mode", selected: ["SQLite"], custom: "and a note" }], commandId: "asks-answer-both", device }),
    /either an option or free text/,
  );

  const result = await manager.resolveInput({
    requestId: "question-1",
    answers: [{ id: "mode", selected: ["SQLite"] }],
    commandId: "asks-answer-1",
    device,
  });
  assert.deepEqual(result, { requestId: "question-1", outcome: "answered" });
  assert.deepEqual(answered, [{ requestId: "question-1", answers: [{ id: "mode", selected: ["SQLite"] }], cancel: false }]);
  assert.equal(eventStore.listAfter(0, { sessionId: session.id }).filter((event) => event.kind === "input.resolved").length, 1);

  await assert.rejects(
    manager.resolveInput({ requestId: "question-1", answers: [], commandId: "asks-answer-2", device }),
    (error) => error.statusCode === 409,
  );
});

test("an unanswered question is dropped when its turn ends", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-question-drop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  registry.register({
    id: "asks-then-ends",
    label: "Asks then ends",
    capabilities: { create: true, answer: true },
    async detect() { return { available: true }; },
    async start() { return { providerSessionId: "asks-then-ends-1" }; },
    async send(_handle, { emit }) {
      await emit("turn.started", { adapter: "asks-then-ends" }, { turnId: "short-turn" });
      await emit("input.requested", {
        requestId: "question-2",
        adapter: "asks-then-ends",
        questions: [{ id: "go", question: "Proceed?" }],
      }, { turnId: "short-turn" });
      await emit("turn.completed", { status: "cancelled" }, { turnId: "short-turn" });
    },
    async resolveInput() { throw new Error("a question from a finished turn must not be answerable"); },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]), deltaFlushMs: 5 });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "asks-then-ends", projectAlias: "demo", title: "Short", commandId: "short-create", device });
  const finished = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind !== "turn.completed") return;
      unsubscribe();
      resolve(event);
    });
  });
  await manager.send({ sessionId: session.id, text: "go", commandId: "short-send-1", device });
  await finished;

  await assert.rejects(
    manager.resolveInput({ requestId: "question-2", answers: [{ id: "go", selected: [] }], commandId: "short-answer-1", device }),
    (error) => error.statusCode === 409,
  );
});

// A phone re-reads this stream on every load, so what a status event carries is
// a latency cost. `session.ready` used to embed the whole model directory.
test("status events stay small and never repeat the model directory", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-payload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const directoryGroups = Array.from({ length: 60 }, (_value, index) => ({
    id: `provider-${index}`,
    name: `Provider ${index}`,
    models: Array.from({ length: 8 }, (_entry, model) => ({ id: `model-${index}-${model}`, name: `Model ${index}-${model}` })),
  }));
  registry.register({
    id: "fattened",
    label: "Fattened",
    capabilities: { create: true },
    async detect() { return { available: true }; },
    async start() { return { providerSessionId: "fattened-1", modelDirectory: { current: null, groups: directoryGroups, failures: [] } }; },
    modelDirectory() { return { current: null, groups: directoryGroups, failures: [] }; },
    async send(_handle, { emit }) {
      await emit("tool.started", { type: "bash", command: "x".repeat(50_000) }, { turnId: "turn-1" });
      await emit("tool.completed", { type: "bash", text: "y".repeat(50_000) }, { turnId: "turn-1" });
      await emit("turn.completed", { status: "completed" }, { turnId: "turn-1" });
    },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]), deltaFlushMs: 5 });
  const device = { id: "device-a", deviceName: "A" };
  const session = await manager.create({ adapterId: "fattened", projectAlias: "demo", title: "Fat", commandId: "fat-create", device });
  // /api/state still needs the catalog; only the event stream drops it.
  assert.equal(manager.get(session.id).modelDirectory.groups.length, 60);

  const finished = new Promise((resolve) => {
    const unsubscribe = eventStore.subscribe((event) => {
      if (event.kind !== "turn.completed") return;
      unsubscribe();
      resolve();
    });
  });
  await manager.send({ sessionId: session.id, text: "go", commandId: "fat-send-1", device });
  await finished;

  const ready = eventStore.listAfter(0, { sessionId: session.id }).find((event) => event.kind === "session.ready");
  assert.equal("session" in ready.payload, false, "the ready event repeated the whole session view");
  assert.equal(ready.payload.sessionId, session.id);
  assert.ok(Buffer.byteLength(JSON.stringify(ready), "utf8") < 1_000);

  const started = eventStore.listAfter(0, { sessionId: session.id }).find((event) => event.kind === "tool.started");
  assert.ok(started.payload.command.length < 2_100);
  assert.match(started.payload.command, /已截断/);
  const completed = eventStore.listAfter(0, { sessionId: session.id }).find((event) => event.kind === "tool.completed");
  assert.ok(completed.payload.text.length < 4_100);
  assert.match(completed.payload.text, /已截断/);
});
