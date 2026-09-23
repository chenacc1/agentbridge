import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
