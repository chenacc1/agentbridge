import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createBridge } from "../src/server.js";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";
import { ConversationCatalog } from "../src/conversations/conversation-catalog.js";
import { DshDesktopChannelManager } from "../src/dsh-desktop-channels.js";
import { DshDesktopAdapter } from "../src/adapters/dsh-desktop.js";

const DIRECTORY = {
  current: { provider: "ds", model: "ds-chat" },
  routable: true,
  groups: [{ id: "ds", name: "DeepSeek", models: [{ id: "ds-chat", name: "DeepSeek Chat" }] }],
  failures: [],
};

function pair(channels, providerSessionId = "dsh-carrier-session") {
  return channels.register({
    providerSessionId,
    cwd: "D:\\work",
    title: "Carrier",
    provider: "ds",
    model: "ds-chat",
    modelDirectory: DIRECTORY,
  });
}

test("DSH Desktop can only create conversations while a companion is paired", () => {
  const channels = new DshDesktopChannelManager();
  const adapter = new DshDesktopAdapter({ channels });

  assert.equal(adapter.capabilities.create, false);
  assert.equal(adapter.capabilities.createReason, "桌面端离线");

  pair(channels);
  assert.equal(adapter.capabilities.create, true);
  assert.equal(adapter.capabilities.createReason, undefined);
});

test("creating without a paired desktop fails with the reason instead of hanging", () => {
  const channels = new DshDesktopChannelManager();
  assert.throws(
    () => channels.requestSession({ cwd: "D:\\work", bridgeSessionId: "bs_pending" }),
    /桌面端离线/,
  );
});

test("a create request rides an existing channel and settles when the companion registers", async () => {
  const channels = new DshDesktopChannelManager();
  const carrier = pair(channels);
  const pending = channels.requestSession({ cwd: "D:\\work", title: "新建", bridgeSessionId: "bs_pending" });

  const command = channels.poll(carrier.id, carrier.token, 0).commands.at(-1);
  assert.equal(command.kind, "create-session");
  assert.equal(command.bridgeSessionId, "bs_pending");
  assert.equal(command.cwd, "D:\\work");
  assert.ok(command.requestId);

  const settled = channels.settleCreate("bs_pending", { providerSessionId: "dsh-new-session" });
  assert.equal(settled, true);
  assert.deepEqual(await pending, { providerSessionId: "dsh-new-session" });
  // A second settle must not resurrect a finished request.
  assert.equal(channels.settleCreate("bs_pending", { providerSessionId: "again" }), false);
});

test("a failed create is reported immediately rather than waiting for the timeout", async () => {
  const channels = new DshDesktopChannelManager();
  const carrier = pair(channels);
  const pending = channels.requestSession({ cwd: "D:\\work", bridgeSessionId: "bs_pending" });
  const command = channels.poll(carrier.id, carrier.token, 0).commands.at(-1);

  const receipt = channels.complete(carrier.id, carrier.token, command.requestId, { ok: false, error: "no model configured" });
  assert.deepEqual(receipt, { accepted: true });
  await assert.rejects(pending, /no model configured/);
});

test("the adapter starts a conversation through the companion and wires the bridge to it", async () => {
  const channels = new DshDesktopChannelManager();
  const carrier = pair(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const emitted = [];
  const started = adapter.start({
    cwd: "D:\\work",
    projectAlias: "demo",
    bridgeSessionId: "bs_pending",
    emit: async (...args) => emitted.push(args),
  });

  const command = channels.poll(carrier.id, carrier.token, 0).commands.at(-1);
  assert.equal(command.kind, "create-session");
  const created = channels.register({
    providerSessionId: "dsh-created-session",
    cwd: "D:\\work",
    title: "Created",
    provider: "ds",
    model: "ds-chat",
    modelDirectory: DIRECTORY,
  });
  channels.settleCreate("bs_pending", { providerSessionId: created.providerSessionId });

  const handle = await started;
  assert.equal(handle.providerSessionId, "dsh-created-session");
  assert.equal(adapter.modelDirectory(handle).groups[0].id, "ds");

  // The new conversation streams into the bridge session that asked for it.
  await channels.ingest(created.id, created.token, [
    { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 7 } }, origin: "desktop" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(emitted.some(([kind]) => kind === "turn.started"), `expected a mapped event, got ${JSON.stringify(emitted)}`);
});

async function bridgeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-create-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const conversationCatalog = new ConversationCatalog({ filePath: path.join(directory, "bridge-sessions.json") });
  await conversationCatalog.init();
  const channels = new DshDesktopChannelManager();
  const registry = new AdapterRegistry();
  registry.register(new DshDesktopAdapter({ channels }));
  const manager = new SessionManager({
    eventStore,
    registry,
    conversationCatalog,
    projects: new Map([["demo", directory]]),
  });
  return { directory, eventStore, conversationCatalog, channels, registry, manager };
}

test("the phone opens a DSH Desktop conversation and keeps control of it", async (t) => {
  const { channels, manager, conversationCatalog } = await bridgeFixture(t);
  const carrier = pair(channels);
  const device = { id: "phone-a", deviceName: "Phone" };

  const creating = manager.create({
    adapterId: "deepseek-harness-desktop",
    projectAlias: "demo",
    title: "手机新建的会话",
    commandId: "create-dsh-1",
    device,
  });

  const command = await (async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = channels.poll(carrier.id, carrier.token, 0).commands.find((entry) => entry.kind === "create-session");
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the create command never reached the companion");
  })();

  const created = channels.register({
    providerSessionId: "dsh-phone-created",
    cwd: "D:\\work",
    title: "手机新建的会话",
    provider: "ds",
    model: "ds-chat",
    modelDirectory: DIRECTORY,
  });
  channels.settleCreate(command.bridgeSessionId, { providerSessionId: created.providerSessionId });

  const session = await creating;
  assert.equal(session.status, "ready");
  assert.equal(session.providerSessionId, "dsh-phone-created");
  assert.equal(session.modelDirectory.groups[0].models[0].id, "ds-chat");
  assert.equal(session.controller.deviceId, device.id);

  // The model directory is persisted, so the row survives a bridge restart.
  const stored = conversationCatalog.get(session.id);
  assert.equal(stored.modelDirectory.groups[0].id, "ds");
  assert.equal(stored.modelDirectory.current.model, "ds-chat");
});

test("a conversation whose Agent is offline still remembers its model directory", async (t) => {
  const { channels, manager, conversationCatalog, registry, eventStore } = await bridgeFixture(t);
  const paired = pair(channels, "dsh-offline-session");
  const device = { id: "phone-a", deviceName: "Phone" };
  const attached = await manager.attach({
    adapterId: "deepseek-harness-desktop",
    projectAlias: "demo",
    providerSessionId: paired.providerSessionId,
    title: "离线也要记得模型",
    commandId: "attach-dsh-1",
    device,
  });
  assert.equal(attached.modelDirectory.groups[0].models[0].id, "ds-chat");

  // Restart: same catalog file, brand new process state.
  const reopened = new ConversationCatalog({ filePath: conversationCatalog.filePath });
  await reopened.init();
  const reloaded = new SessionManager({
    eventStore,
    registry,
    conversationCatalog: reopened,
    projects: new Map([["demo", manager.projects.get("demo")]]),
  });
  const offline = reloaded.get(attached.id);
  assert.equal(offline.status, "offline");
  assert.equal(offline.modelDirectory.current.model, "ds-chat");
  assert.equal(offline.modelDirectory.groups[0].models[0].name, "DeepSeek Chat");
});

test("a stored model directory is capped and rejected when it is not an object", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-catalog-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = new ConversationCatalog({ filePath: path.join(directory, "bridge-sessions.json") });
  await catalog.init();
  const record = await catalog.create({
    projectAlias: "demo",
    adapterId: "deepseek-harness-desktop",
    title: "capped",
    modelDirectory: {
      current: { provider: "ds", model: "ds-chat" },
      routable: true,
      groups: Array.from({ length: 40 }, (_, index) => ({
        id: `p${index}`,
        name: `Provider ${index}`,
        models: Array.from({ length: 60 }, (__, modelIndex) => ({ id: `m${modelIndex}`, name: `Model ${modelIndex}` })),
      })),
      failures: [],
    },
  });
  assert.equal(record.modelDirectory.groups.length, 20);
  assert.equal(record.modelDirectory.groups[0].models.length, 40);

  const updated = await catalog.update(record.id, { modelDirectory: "not a directory" });
  assert.equal(updated.modelDirectory, null);
});

test("a reconnecting companion keeps its conversation, its lease and the device list", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-reconnect-"));
  const bridge = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: directory,
      projects: new Map([["app", directory]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "Reconnect test",
    },
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const body = {
    sessionId: "dsh-reconnect-session",
    cwd: directory,
    title: "断线重连",
    provider: "ds",
    model: "ds-chat",
  };
  const first = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  assert.ok(first.pairing, "the first registration still mints a pairing");

  // The phone takes the conversation over.
  const phone = (await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  await fetch(`${origin}/api/sessions/${first.session.id}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phone, origin },
    body: JSON.stringify({ commandId: "reconnect-claim-1" }),
  });
  const devicesBefore = (await (await fetch(`${origin}/api/devices`, { headers: { cookie: phone } })).json()).devices.length;

  const second = await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, reconnect: true }),
  });
  assert.equal(second.status, 200);
  const reconnected = await second.json();
  assert.equal(reconnected.reconnected, true);
  assert.equal(reconnected.pairing, undefined, "a reconnect must not hand out another pairing");
  assert.equal(reconnected.session.id, first.session.id, "a reconnect must not create a second conversation");
  assert.ok(reconnected.channel.pollPath);

  const devicesAfter = (await (await fetch(`${origin}/api/devices`, { headers: { cookie: phone } })).json()).devices.length;
  assert.equal(devicesAfter, devicesBefore, "a reconnect must not add a device");

  const state = await (await fetch(`${origin}/api/state`, { headers: { cookie: phone } })).json();
  const session = state.sessions.find((entry) => entry.id === first.session.id);
  assert.equal(session.status, "ready");
  assert.ok(session.controller, "the reconnect dropped the phone's input lease");
});
// "DSH Desktop companion is not registered" was accurate and useless: it named neither
// the cause (the desktop side is not connected to this conversation) nor the fix (run
// /phone there). Both facts now travel with the error, and the same check tells the phone
// whether a listed conversation can be driven at all.
test("a conversation without a live companion says what to do instead of naming an internal rule", () => {
  const channels = new DshDesktopChannelManager();
  const registration = pair(channels, "dsh-carrier-session");

  assert.equal(channels.isOnline("dsh-carrier-session"), true);
  assert.equal(channels.isOnline("dsh-never-registered"), false);
  assert.equal(channels.isOnline(""), false);

  assert.throws(
    () => channels.attachBridge("dsh-never-registered", { onEvent() {} }),
    (error) => error.statusCode === 409 && error.message.includes("/phone") && error.message.includes("桌面端"),
  );

  // Closing the channel is what a bridge restart looks like from the desktop's side.
  channels.revoke(registration.id);
  assert.equal(channels.isOnline("dsh-carrier-session"), false);
  assert.throws(
    () => channels.enqueue("dsh-carrier-session", { kind: "message", text: "hi" }),
    (error) => error.statusCode === 409 && error.message.includes("/phone"),
  );
});
test("a stale desktop integration is reported instead of failing silently", async (t) => {
  const channels = new DshDesktopChannelManager();
  assert.deepEqual(channels.integrationStatus(), { paired: false, version: null, required: 5, stale: false });

  channels.register({
    providerSessionId: "dsh-old-build",
    cwd: "D:\\work",
    title: "旧集成",
    integrationVersion: 2,
  });
  const stale = channels.integrationStatus();
  assert.equal(stale.paired, true);
  assert.equal(stale.version, 2);
  assert.equal(stale.stale, true);

  // v3 reconnects, but it can only ever make one re-registration attempt, so a bridge
  // that is still down when that attempt lands leaves the conversation dead.
  channels.register({
    providerSessionId: "dsh-old-build",
    cwd: "D:\\work",
    title: "旧集成",
    integrationVersion: 3,
  });
  assert.equal(channels.integrationStatus().stale, true);

  // v4 retries forever, but its event batches could still be refused outright, which
  // wedged the channel behind one giant tool output.
  channels.register({
    providerSessionId: "dsh-old-build",
    cwd: "D:\\work",
    title: "旧集成",
    integrationVersion: 4,
  });
  assert.equal(channels.integrationStatus().stale, true);

  // Re-registering with the version that shrinks oversized batches clears the warning.
  channels.register({
    providerSessionId: "dsh-old-build",
    cwd: "D:\\work",
    title: "旧集成",
    integrationVersion: 5,
  });
  assert.equal(channels.integrationStatus().stale, false);
});