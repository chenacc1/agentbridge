import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createBridge } from "../src/server.js";
import { AdapterRegistry } from "../src/adapter-registry.js";

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("Cloudflare mode keeps the loopback desktop login usable over HTTP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-cloudflare-local-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "https://example.trycloudflare.com",
    accessKey: "test-access-key",
    secureCookies: true,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Cloudflare local test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const address = bridge.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const login = await fetch(`${origin}/api/local-session`, {
    method: "POST",
    headers: { origin },
  });
  assert.equal(login.status, 201);
  assert.doesNotMatch(login.headers.get("set-cookie"), /; Secure/i);

  const cookie = cookieFrom(login);
  const state = await fetch(`${origin}/api/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  const deviceId = (await state.json()).device.id;

  const revoke = await fetch(`${origin}/api/devices/${deviceId}/revoke`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(revoke.status, 200);
  assert.doesNotMatch(revoke.headers.get("set-cookie"), /; Secure/i);
});

test("local safe shutdown rejects active turns, disposes sessions, and closes the HTTP server", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-safe-shutdown-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Shutdown test",
  };
  let completeTurn;
  let disposeCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "shutdown-test",
    label: "Shutdown Test",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    start: async () => ({ providerSessionId: "shutdown-provider" }),
    send: async (_handle, { emit }) => {
      await new Promise((resolve) => { completeTurn = resolve; });
      await emit("turn.completed", { status: "completed" }, { turnId: "shutdown-turn" });
    },
    dispose: async () => { disposeCalls += 1; },
  });
  let resolveShutdown;
  const didShutdown = new Promise((resolve) => { resolveShutdown = resolve; });
  const bridge = await createBridge({ config, registry, onShutdown: resolveShutdown });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const address = bridge.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (bridge.server.listening) {
      bridge.server.closeAllConnections();
      await new Promise((resolve) => bridge.server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${origin}/api/local/shutdown`, { method: "POST", headers: { origin } });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const cookie = cookieFrom(login);
  const create = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ adapterId: "shutdown-test", projectAlias: "demo", commandId: "shutdown-create" }),
  });
  const session = (await create.json()).session;
  const send = await fetch(`${origin}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "keep running", commandId: "shutdown-send" }),
  });
  assert.equal(send.status, 202);

  const blocked = await fetch(`${origin}/api/local/shutdown`, { method: "POST", headers: { origin, cookie } });
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, "ACTIVE_SESSIONS");
  assert.equal(blockedBody.diagnostics.count, 1);
  assert.deepEqual(Object.keys(blockedBody.diagnostics.sessions[0]).sort(), ["adapterId", "id", "status", "title"]);

  completeTurn();
  const deadline = Date.now() + 2_000;
  while (bridge.sessions.list()[0].status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(bridge.sessions.list()[0].status, "ready");

  const accepted = await fetch(`${origin}/api/local/shutdown`, { method: "POST", headers: { origin, cookie } });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, true);
  await Promise.race([
    didShutdown,
    new Promise((_, reject) => setTimeout(() => reject(new Error("safe shutdown timed out")), 3_000)),
  ]);
  assert.equal(disposeCalls, 1);
  assert.equal(bridge.server.listening, false);
  assert.equal(bridge.sessions.list()[0].status, "offline");
});

test("bridge startup reloads persisted sessions as offline without starting providers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-bridge-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const makeConfig = () => ({
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Restart test",
  });
  let starts = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "restartable",
    label: "Restartable",
    capabilities: { create: true, attach: true, resume: true },
    detect: async () => ({ available: true, supported: true }),
    start: async () => {
      starts += 1;
      return { providerSessionId: "restart-provider-123" };
    },
    attach: async (_context, providerSessionId) => ({ providerSessionId }),
  });

  const firstBridge = await createBridge({ config: makeConfig(), registry });
  const created = await firstBridge.sessions.create({
    adapterId: "restartable",
    projectAlias: "demo",
    title: "Restart me",
    commandId: "restart-create",
    device: { id: "device-a", deviceName: "A" },
  });
  const secondBridge = await createBridge({ config: makeConfig(), registry });
  const restored = secondBridge.sessions.list()[0];

  assert.equal(restored.id, created.id);
  assert.equal(restored.status, "offline");
  assert.equal(restored.providerSessionId, "restart-provider-123");
  assert.equal(starts, 1, "Bridge startup must not start a second provider process");
});

test("HTTP bridge completes local login, one-time pairing, idempotent command, and SSE replay", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-server-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Test machine",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const address = bridge.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);

  const applicationShell = await fetch(`${origin}/`);
  assert.equal(applicationShell.status, 200);
  assert.match(await applicationShell.text(), /AgentBridge/);
  assert.equal(applicationShell.headers.get("cache-control"), "no-store");

  const applicationScript = await fetch(`${origin}/app.js`);
  assert.equal(applicationScript.status, 200);
  assert.equal(applicationScript.headers.get("cache-control"), "no-store");

  const markdownScript = await fetch(`${origin}/markdown.js`);
  assert.equal(markdownScript.status, 200);
  assert.equal(markdownScript.headers.get("cache-control"), "no-store");
  assert.match(await markdownScript.text(), /renderMessageMarkdown/);

  const adapterCapabilitiesScript = await fetch(`${origin}/adapter-capabilities.js`);
  assert.equal(adapterCapabilitiesScript.status, 200);
  assert.equal(adapterCapabilitiesScript.headers.get("cache-control"), "no-store");
  assert.match(await adapterCapabilitiesScript.text(), /adapterCreationPresentation/);

  const workspaceNavigationScript = await fetch(`${origin}/workspace-navigation.js`);
  assert.equal(workspaceNavigationScript.status, 200);
  assert.equal(workspaceNavigationScript.headers.get("cache-control"), "no-store");
  assert.match(await workspaceNavigationScript.text(), /resolveWorkspaceNavigation/);

  const returnQr = await fetch(`${origin}/api/return-qr.svg`);
  assert.equal(returnQr.status, 200);
  assert.match(returnQr.headers.get("content-type"), /image\/svg\+xml/);

  const localLogin = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  assert.equal(localLogin.status, 201);
  assert.match(localLogin.headers.get("set-cookie"), /Max-Age=60/);
  const desktopCookie = cookieFrom(localLogin);

  const stateResponse = await fetch(`${origin}/api/state`, { headers: { cookie: desktopCookie } });
  const state = await stateResponse.json();
  assert.equal(state.machine.name, "Test machine");
  assert.equal(state.projects[0], "demo");
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.workspaces[0].alias, "demo");
  assert.match(state.workspaces[0].id, /^ws_/);
  assert.equal("canonicalPath" in state.workspaces[0], false);

  const workspacesResponse = await fetch(`${origin}/api/workspaces`, { headers: { cookie: desktopCookie } });
  assert.equal(workspacesResponse.status, 200);
  const workspaces = await workspacesResponse.json();
  assert.ok(Number.isSafeInteger(workspaces.revision));
  assert.deepEqual(workspaces.items, state.workspaces);

  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const mobileLogin = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: bootstrap.pairing.id, deviceName: "Phone" }),
  });
  assert.equal(mobileLogin.status, 201);
  assert.match(cookieFrom(mobileLogin), /^agentbridge_session=/);
  const replayLogin = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: bootstrap.pairing.id, deviceName: "Other" }),
  });
  assert.equal(replayLogin.status, 410);

  const createBody = { adapterId: "echo", projectAlias: "demo", title: "HTTP demo", commandId: "http-create-command" };
  const firstCreate = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: desktopCookie, origin },
    body: JSON.stringify(createBody),
  });
  const firstSession = (await firstCreate.json()).session;
  const secondCreate = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: desktopCookie, origin },
    body: JSON.stringify(createBody),
  });
  assert.equal((await secondCreate.json()).session.id, firstSession.id);

  const sendBody = { text: "hello from integration test", commandId: "http-send-command" };
  const send = () => fetch(`${origin}/api/sessions/${firstSession.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: desktopCookie, origin },
    body: JSON.stringify(sendBody),
  });
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const userEvents = bridge.eventStore.listAfter(0).filter((event) => event.kind === "message.completed" && event.payload.role === "user");
  assert.equal(userEvents.length, 1);

  const abort = new AbortController();
  const stream = await fetch(`${origin}/api/events?after=0`, { headers: { cookie: desktopCookie }, signal: abort.signal });
  const chunk = await stream.body.getReader().read();
  abort.abort();
  assert.match(new TextDecoder().decode(chunk.value), /event: agent-event/);
});

test("conversation API lists the local catalog and refreshes provider discovery on demand", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-conversation-api-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Conversation API test",
  };
  let discoveryCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    id: "discoverable",
    label: "Discoverable",
    capabilities: { create: false, attach: true, discover: true, resume: true },
    detect: async () => ({ available: true, supported: true }),
    discoverConversations: async ({ workspace }) => {
      discoveryCalls += 1;
      assert.equal(workspace.canonicalPath, directory);
      return {
        conversations: [{
          providerConversationId: "http-provider-thread-123",
          title: "HTTP discovered thread",
          createdAt: "2026-09-20T00:00:00.000Z",
          lastActiveAt: "2026-09-23T12:00:00.000Z",
        }],
        diagnostics: { status: "available", protocol: "test/list", pages: 1 },
      };
    },
    attach: async (_context, providerSessionId) => ({ providerSessionId }),
  });
  const bridge = await createBridge({ config, registry });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const localLogin = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const cookie = cookieFrom(localLogin);
  const workspace = (await (await fetch(`${origin}/api/workspaces`, { headers: { cookie } })).json()).items[0];

  const localOnly = await fetch(`${origin}/api/conversations?workspaceId=${workspace.id}&adapterId=discoverable`, { headers: { cookie } });
  assert.equal(localOnly.status, 200);
  assert.equal((await localOnly.json()).items.length, 0);
  assert.equal(discoveryCalls, 0);

  const refreshed = await fetch(`${origin}/api/conversations?workspaceId=${workspace.id}&adapterId=discoverable&refresh=1`, {
    headers: { cookie, origin },
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = await refreshed.json();
  assert.equal(refreshedBody.discovery.created, 1);
  assert.equal(refreshedBody.items.length, 1);
  assert.equal(refreshedBody.items[0].title, "HTTP discovered thread");
  assert.equal(refreshedBody.items[0].workspaceId, workspace.id);
  assert.equal(discoveryCalls, 1);

  const repeated = await fetch(`${origin}/api/conversations?workspaceId=${workspace.id}&adapterId=discoverable&refresh=1`, {
    headers: { cookie, origin },
  });
  assert.equal((await repeated.json()).items[0].id, refreshedBody.items[0].id);
  assert.equal(bridge.conversationCatalog.list().length, 1);
});

test("local phone launcher binds its cwd and QR to the created session", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-phone-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:9999",
    secureCookies: false,
    dataDir: directory,
    projects: new Map(),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Phone test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const workspaceRegistration = await fetch(`${origin}/api/local/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: directory }),
  });
  assert.equal(workspaceRegistration.status, 201);
  const registeredWorkspace = (await workspaceRegistration.json()).workspace;
  assert.match(registeredWorkspace.id, /^ws_/);
  assert.equal("canonicalPath" in registeredWorkspace, false);
  assert.equal(config.projects.get(registeredWorkspace.alias), directory);

  const launch = await fetch(`${origin}/api/local/phone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: directory, adapterId: "echo", title: "Folder-bound conversation", commandId: "local-phone-command" }),
  });
  assert.equal(launch.status, 201);
  const launched = await launch.json();
  assert.equal(launched.pairing.targetSessionId, launched.session.id);
  assert.equal(config.projects.get(launched.project.alias), directory);
  assert.match(launched.qrImageUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/local\/pairings\/[^/]+\/qr\.svg$/);
  const pairingImage = await fetch(launched.qrImageUrl);
  assert.equal(pairingImage.status, 200);
  assert.match(pairingImage.headers.get("content-type"), /image\/svg\+xml/);

  const exchange = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: launched.pairing.id, deviceName: "Bound phone" }),
  });
  assert.equal(exchange.status, 201);
  const exchanged = await exchange.json();
  assert.equal(exchanged.targetSessionId, launched.session.id);

  const usedPairingImage = await fetch(launched.qrImageUrl);
  assert.equal(usedPairingImage.status, 410);

  const phoneCookie = cookieFrom(exchange);
  const state = await (await fetch(`${origin}/api/state`, { headers: { cookie: phoneCookie } })).json();
  assert.equal(state.sessions[0].id, launched.session.id);
  assert.equal(state.sessions[0].controller.deviceName, "Bound phone");
  assert.equal(state.device.lastSessionId, launched.session.id);

  const remember = await fetch(`${origin}/api/recent-session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: phoneCookie },
    body: JSON.stringify({ sessionId: launched.session.id }),
  });
  assert.equal(remember.status, 200);
  assert.equal((await remember.json()).resumeSessionId, launched.session.id);
});

test("DSH Desktop /phone binds the exact session and bridges messages and events", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-desktop-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:9999",
    secureCookies: false,
    dataDir: directory,
    projects: new Map(),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "DSH Desktop test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const legacyRegistration = await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "desktop-session-123",
      cwd: directory,
      title: "Exact DSH conversation",
      provider: "deepseek",
      model: "deepseek-chat",
    }),
  });
  assert.equal(legacyRegistration.status, 201);
  assert.equal((await legacyRegistration.json()).session.modelDirectory, null);

  const registeredResponse = await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "desktop-session-123",
      cwd: directory,
      title: "Exact DSH conversation",
      provider: "deepseek",
      model: "deepseek-chat",
      modelDirectory: {
        current: { provider: "deepseek", model: "deepseek-chat" },
        routable: true,
        groups: [{
          id: "deepseek",
          name: "DeepSeek",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "high", name: "High" }] } }],
        }],
        failures: [],
      },
    }),
  });
  assert.equal(registeredResponse.status, 201);
  const registered = await registeredResponse.json();
  assert.equal(registered.session.providerSessionId, "desktop-session-123");
  assert.equal(registered.session.adapterId, "deepseek-harness-desktop");
  assert.deepEqual(registered.session.modelDirectory.current, { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(registered.pairing.targetSessionId, registered.session.id);
  assert.equal(registered.project.cwd, directory);

  const qr = await fetch(registered.qrImageUrl);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);

  const exchange = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: registered.pairing.id, deviceName: "WeChat DSH" }),
  });
  assert.equal(exchange.status, 201);
  const phoneCookie = cookieFrom(exchange);

  const selectModel = fetch(`${origin}/api/sessions/${registered.session.id}/model`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phoneCookie, origin },
    body: JSON.stringify({ provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high", commandId: "dsh-desktop-model-1" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const modelPoll = await fetch(`${origin}${registered.channel.pollPath}?after=0`, {
    headers: { authorization: `Bearer ${registered.channel.token}` },
  });
  const modelCommand = (await modelPoll.json()).commands.find((command) => command.kind === "select-model");
  assert.ok(modelCommand);
  const modelResult = await fetch(`${origin}${registered.channel.resultsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${registered.channel.token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: modelCommand.requestId, result: {
      ok: true,
      selected: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    } }),
  });
  assert.equal(modelResult.status, 202);
  assert.equal((await selectModel).status, 200);

  const send = await fetch(`${origin}/api/sessions/${registered.session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phoneCookie, origin },
    body: JSON.stringify({ text: "continue this exact session", commandId: "dsh-desktop-send-1" }),
  });
  assert.equal(send.status, 202);

  const poll = await fetch(`${origin}${registered.channel.pollPath}?after=${modelCommand.seq}`, {
    headers: { authorization: `Bearer ${registered.channel.token}` },
  });
  assert.equal(poll.status, 200);
  const polled = await poll.json();
  assert.equal(polled.commands[0].text, "continue this exact session");

  const ingest = await fetch(`${origin}${registered.channel.eventsPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${registered.channel.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: [
      { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } },
      {
        event: { type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "same-session reply" }], source: { kind: "model", provider: "deepseek", model: "deepseek-chat" } } } },
      },
      {
        event: { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
      },
    ] }),
  });
  assert.equal(ingest.status, 202);
  const events = bridge.eventStore.listAfter(0).filter((event) => event.sessionId === registered.session.id);
  assert.ok(events.some((event) => event.kind === "message.completed" && event.payload.text === "same-session reply"));
  assert.ok(events.some((event) => event.kind === "model.changed" && event.payload.selected.reasoningEffort === "high"));
  assert.equal(bridge.sessions.list()[0].status, "ready");
});

// The end-to-end bar for this bug: a question raised inside DSH Desktop must
// reach the phone as a real HTTP answer that the desktop companion can confirm.
test("a DSH Desktop question becomes an answerable phone request over HTTP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-question-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map(),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "DSH question test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const registered = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "desktop-question-session", cwd: directory, title: "Question session", provider: "deepseek", model: "deepseek-chat" }),
  })).json();
  assert.match(registered.channel.interactionsPath, /\/interactions$/);

  const exchange = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: registered.pairing.id, deviceName: "WeChat question" }),
  });
  const phoneCookie = cookieFrom(exchange);

  const posted = await fetch(`${origin}${registered.channel.interactionsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${registered.channel.token}`, "content-type": "application/json" },
    body: JSON.stringify({ interactions: [{
      kind: "question-requested",
      requestId: "dsh-rpc-http-question",
      questions: [{
        id: "mode",
        header: "Choose Mode",
        question: "Which storage should I use?",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
      }],
    }] }),
  });
  assert.equal(posted.status, 202);

  const requested = bridge.eventStore.listAfter(0, { sessionId: registered.session.id }).find((event) => event.kind === "input.requested");
  assert.ok(requested, "the question never reached the phone transcript");

  const answering = fetch(`${origin}/api/requests/${encodeURIComponent(requested.payload.requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phoneCookie, origin },
    body: JSON.stringify({ commandId: "dsh-question-answer-1", answers: [{ id: "mode", selected: ["SQLite"] }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const poll = await (await fetch(`${origin}${registered.channel.pollPath}?after=0`, {
    headers: { authorization: `Bearer ${registered.channel.token}` },
  })).json();
  const command = poll.commands.find((entry) => entry.kind === "answer-question");
  assert.ok(command, "the answer never reached the desktop companion");
  assert.equal(command.rpcId, "dsh-rpc-http-question");
  assert.deepEqual(command.answers, [{ id: "mode", selected: ["SQLite"] }]);

  const confirmed = await fetch(`${origin}${registered.channel.resultsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${registered.channel.token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: command.requestId, result: { ok: true } }),
  });
  assert.equal(confirmed.status, 202);
  const answer = await answering;
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { requestId: requested.payload.requestId, outcome: "answered" });
  assert.ok(bridge.eventStore.listAfter(0, { sessionId: registered.session.id }).some((event) => event.kind === "input.resolved"));

  const again = await fetch(`${origin}/api/requests/${encodeURIComponent(requested.payload.requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phoneCookie, origin },
    body: JSON.stringify({ commandId: "dsh-question-answer-2", answers: [] }),
  });
  assert.equal(again.status, 409);
});

// Both halves of the "switch to another conversation and see nothing" report:
// history must be fetchable per session, and a fresh page must not have to pull
// the entire global window before it can show anything.
test("session history is served per conversation and the first replay is bounded", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-history-api-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "History test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const cookie = cookieFrom(login);
  const created = await (await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ adapterId: "echo", projectAlias: "demo", title: "History", commandId: "history-create-1" }),
  })).json();
  const sessionId = created.session.id;

  // A quiet conversation recorded long before a noisy one must still be readable.
  for (let index = 0; index < 3; index += 1) {
    await bridge.eventStore.append("message.completed", { role: "assistant", text: `history ${index}` }, { sessionId, turnId: "turn-1" });
  }
  for (let index = 0; index < 620; index += 1) {
    await bridge.eventStore.append("tool.completed", { type: "bash", text: `noise ${index}` }, { sessionId: "noisy-session" });
  }

  const history = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/history`, { headers: { cookie } });
  assert.equal(history.status, 200);
  assert.match(history.headers.get("cache-control"), /no-store/);
  const body = await history.json();
  assert.equal(body.sessionId, sessionId);
  assert.deepEqual(
    body.events.filter((event) => event.kind === "message.completed").map((event) => event.payload.text),
    ["history 0", "history 1", "history 2"],
  );
  assert.equal(body.truncated, false);

  const missing = await fetch(`${origin}/api/sessions/bs_missing/history`, { headers: { cookie } });
  assert.equal(missing.status, 404);

  // A fresh page (no Last-Event-ID) gets the newest slice, not the whole window.
  const abort = new AbortController();
  const stream = await fetch(`${origin}/api/events`, { headers: { cookie }, signal: abort.signal });
  const chunk = await stream.body.getReader().read();
  abort.abort();
  const firstId = Number(/id: (\d+)/.exec(new TextDecoder().decode(chunk.value))?.[1] ?? 0);
  assert.ok(firstId > 0, "the fresh replay did not start from a sequence number");
  assert.ok(firstId >= bridge.eventStore.lastSeq - 505, `a fresh page replayed from ${firstId} of ${bridge.eventStore.lastSeq}`);
});

// Formula typesetting is served from the installed KaTeX package on this machine,
// never from a CDN, and only for its own asset types.
test("the formula engine is served locally and nothing else from its directory", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-katex-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map(),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Katex test",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const script = await fetch(`${origin}/vendor/katex/katex.min.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/);
  assert.ok((await script.text()).length > 1000);

  const stylesheet = await fetch(`${origin}/vendor/katex/katex.min.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);

  const font = await fetch(`${origin}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get("content-type"), /font\/woff2/);

  // Only the engine's own asset types, and never a path that escapes its folder.
  for (const attempt of ["package.json", "%2e%2e/package.json", "..%2Fpackage.json", "katex.min.js/../../package.json"]) {
    const response = await fetch(`${origin}/vendor/katex/${attempt}`);
    assert.notEqual(response.status, 200, `served ${attempt} from the KaTeX folder`);
    assert.doesNotMatch(await response.text(), /"name":\s*"katex"/);
  }

  // The shell keeps scripts same-origin while allowing KaTeX's inline styles.
  const shell = await fetch(`${origin}/`);
  const policy = shell.headers.get("content-security-policy");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
});

// The phone asks for one page at a time and pages backwards on request.
test("session history can be paged backwards over HTTP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-history-page-api-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "History paging",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const cookie = cookieFrom(login);
  const created = await (await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ adapterId: "echo", projectAlias: "demo", title: "Paging", commandId: "paging-create-1" }),
  })).json();
  const sessionId = created.session.id;
  for (let index = 1; index <= 12; index += 1) {
    await bridge.eventStore.append("message.completed", { role: "assistant", text: `p${index}` }, { sessionId });
  }

  const messages = (page) => page.events.filter((event) => event.kind === "message.completed").map((event) => event.payload.text);
  const first = await (await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/history?limit=5`, { headers: { cookie } })).json();
  assert.deepEqual(messages(first), ["p8", "p9", "p10", "p11", "p12"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.oldestSeq, first.events[0].seq);

  const second = await (await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/history?limit=5&before=${first.oldestSeq}`, { headers: { cookie } })).json();
  assert.deepEqual(messages(second), ["p3", "p4", "p5", "p6", "p7"]);
  assert.equal(second.hasMore, true);

  const third = await (await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/history?limit=5&before=${second.oldestSeq}`, { headers: { cookie } })).json();
  assert.deepEqual(messages(third), ["p1", "p2"]);
  assert.equal(third.hasMore, false, "the oldest page must say nothing precedes it");
  // The session's own lifecycle events belong to the first page and prove the
  // cursor walks the real stream, not just the appended messages.
  assert.ok(third.events.some((event) => event.kind === "session.created"));
});

test("the phone creates a DSH Desktop conversation through the paired companion", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-create-http-"));
  const projectDirectory = path.join(directory, "app");
  await mkdir(projectDirectory, { recursive: true });
  const bridge = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: directory,
      projects: new Map([["app", projectDirectory]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "DSH create test",
    },
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const directoryValue = {
    current: { provider: "ds", model: "ds-chat" },
    routable: true,
    groups: [{ id: "ds", name: "DeepSeek", models: [{ id: "ds-chat", name: "DeepSeek Chat" }] }],
    failures: [],
  };
  // The companion that will be asked to open the new conversation.
  const carrier = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "dsh-carrier-session",
      cwd: projectDirectory,
      title: "Carrier conversation",
      provider: "ds",
      model: "ds-chat",
      modelDirectory: directoryValue,
    }),
  })).json();

  const stateWhilePaired = await (await fetch(`${origin}/api/state`, {
    headers: { cookie: cookieFrom(await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } })) },
  })).json();
  const pairedAdapter = stateWhilePaired.adapters.find((adapter) => adapter.id === "deepseek-harness-desktop");
  assert.equal(pairedAdapter.capabilities.create, true, "a paired desktop makes the Agent creatable");

  const phone = cookieFrom(await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }));
  const creating = fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phone, origin },
    body: JSON.stringify({
      adapterId: "deepseek-harness-desktop",
      projectAlias: "app",
      title: "手机开的会话",
      commandId: "dsh-create-http-1",
    }),
  });

  // The companion is asked, in its own channel, to open a conversation.
  let createCommand;
  for (let attempt = 0; attempt < 100 && !createCommand; attempt += 1) {
    const polled = await (await fetch(`${origin}${carrier.channel.pollPath}?after=0`, {
      headers: { authorization: `Bearer ${carrier.channel.token}` },
    })).json();
    createCommand = polled.commands.find((command) => command.kind === "create-session");
    if (!createCommand) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(createCommand, "the companion received no create-session command");
  assert.equal(createCommand.cwd, projectDirectory);
  assert.match(createCommand.bridgeSessionId, /^bs_/);

  const created = await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "dsh-created-session",
      cwd: projectDirectory,
      title: "手机开的会话",
      provider: "ds",
      model: "ds-chat",
      modelDirectory: directoryValue,
      bridgeSessionId: createCommand.bridgeSessionId,
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.created, true);
  assert.equal(createdBody.sessionId, createCommand.bridgeSessionId);
  assert.equal(createdBody.pairing, undefined, "a phone-created conversation must not mint a second pairing");
  assert.ok(createdBody.channel.pollPath);

  const response = await creating;
  assert.equal(response.status, 201);
  const { session } = await response.json();
  assert.equal(session.id, createCommand.bridgeSessionId);
  assert.equal(session.status, "ready");
  assert.equal(session.providerSessionId, "dsh-created-session");
  assert.equal(session.adapterId, "deepseek-harness-desktop");
  assert.equal(session.modelDirectory.groups[0].models[0].id, "ds-chat");
  assert.ok(session.controller && session.controller.deviceId, "the phone that asked keeps control");

  // The new conversation's own channel drives the same bridge session.
  const send = await fetch(`${origin}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: phone, origin },
    body: JSON.stringify({ text: "hello from the phone", commandId: "dsh-create-http-2" }),
  });
  assert.equal(send.status, 202);
  const newPoll = await (await fetch(`${origin}${createdBody.channel.pollPath}?after=0`, {
    headers: { authorization: `Bearer ${createdBody.channel.token}` },
  })).json();
  assert.equal(newPoll.commands.at(-1).kind, "message");
  assert.equal(newPoll.commands.at(-1).text, "hello from the phone");
});

test("a second registration for an answered create request is rejected instead of opening a stray session", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-create-stray-"));
  await mkdir(path.join(directory, "app"), { recursive: true });
  const bridge = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: directory,
      projects: new Map([["app", path.join(directory, "app")]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "DSH stray create test",
    },
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const stray = await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "dsh-stray-session",
      cwd: path.join(directory, "app"),
      title: "Stray",
      bridgeSessionId: "bs_that_was_never_asked_for",
    }),
  });
  assert.equal(stray.status, 409);
  assert.equal((await stray.json()).error, 'That create request is no longer waiting');
});
test("the shell is versioned so a phone can cache it, while the HTML stays fresh", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-shell-"));
  const bridge = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: directory,
      projects: new Map(),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "Shell cache test",
    },
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const shell = await fetch(`${origin}/`);
  const html = await shell.text();
  assert.equal(shell.headers.get("cache-control"), "no-store", "the shell must never be cached");
  const versioned = [...html.matchAll(/"\/([a-z-]+\.(?:js|css))\?v=([0-9a-f]{10})"/g)].map((match) => ({ file: match[1], version: match[2] }));
  assert.ok(versioned.length >= 2, `expected the shell to reference versioned assets, saw ${JSON.stringify(versioned)}`);
  const appVersion = versioned.find((asset) => asset.file === "app.js");
  assert.ok(appVersion, "the shell does not version app.js");
  const appSource = await (await fetch(`${origin}/app.js?v=${appVersion.version}`)).text();
  const moduleImports = [...appSource.matchAll(/from "\/([a-z-]+\.js)\?v=([0-9a-f]{10})"/g)];
  assert.ok(moduleImports.length >= 4, `app.js does not version its modules: ${JSON.stringify(moduleImports.map((match) => match[1]))}`);
  for (const match of moduleImports) {
    const response = await fetch(`${origin}/${match[1]}?v=${match[2]}`);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable", `${match[1]} is not cacheable`);
    await response.arrayBuffer();
  }
  for (const asset of versioned) {
    const response = await fetch(`${origin}/${asset.file}?v=${asset.version}`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
      `${asset.file} with its own version is not cacheable: ${response.headers.get("cache-control")}`,
    );
    await response.arrayBuffer();
  }

  // A stale or missing version must not be cached: that is the path a device takes
  // after the bridge is upgraded mid-session.
  const stale = await fetch(`${origin}/app.js?v=deadbeef00`);
  assert.equal(stale.headers.get("cache-control"), "no-store");
  await stale.arrayBuffer();
  const bare = await fetch(`${origin}/app.js`);
  assert.equal(bare.headers.get("cache-control"), "no-store");
  await bare.arrayBuffer();

  // The stylesheet carries the photo's version, so replacing only the picture still
  // busts the cache instead of leaving a stale background forever.
  const cssUrl = versioned.find((asset) => asset.file === "styles.css");
  const css = await (await fetch(`${origin}/styles.css?v=${cssUrl.version}`)).text();
  assert.match(css, /url\("\/background\.jpg\?v=[0-9a-f]{10}"\)/, "the stylesheet does not version the background image");
});