import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createBridge } from "../src/server.js";

/**
 * The plugin restarts the bridge to publish a new address. That restart is the
 * one privileged action a plugin needs, so it gets its own narrow authorisation:
 * loopback plus the token written when the plugin spawned this process.
 */
async function startBridge(t, { autostartToken = "token-from-the-plugin-1234", autostart = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-autostart-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:8787",
    accessKey: null,
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "autostart test",
    autostart,
    autostartToken,
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${bridge.server.address().port}`, bridge };
}

test("the health endpoint tells the plugin what it advertises and how it was started", async (t) => {
  const { origin } = await startBridge(t);
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.advertisedOrigin, "http://127.0.0.1:8787");
  assert.equal(health.accessKeyRequired, false);
  assert.equal(health.autostart, true);
});

test("a restart request without the token is refused", async (t) => {
  const { origin } = await startBridge(t);

  const anonymous = await fetch(`${origin}/api/local/autostart/shutdown`, { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);

  const wrong = await fetch(`${origin}/api/local/autostart/shutdown`, {
    method: "POST",
    body: "{}",
    headers: { "x-agentbridge-autostart": "not-the-token" },
  });
  assert.equal(wrong.status, 401);

  // Still serving: a refused request must change nothing.
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test("a bridge nobody spawned accepts no token at all", async (t) => {
  const { origin } = await startBridge(t, { autostart: false, autostartToken: null });
  const response = await fetch(`${origin}/api/local/autostart/shutdown`, {
    method: "POST",
    body: "{}",
    headers: { "x-agentbridge-autostart": "anything" },
  });
  assert.equal(response.status, 401, "a manually started bridge must never be restartable by a plugin");
});

test("the owning plugin can ask for a restart and the bridge stops serving", async (t) => {
  const token = "token-from-the-plugin-1234";
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-restart-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:8787",
    accessKey: null,
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "restart test",
    autostart: true,
    autostartToken: token,
  };
  let closed = null;
  const closedPromise = new Promise((resolve) => { closed = resolve; });
  const bridge = await createBridge({
    config,
    onShutdown: async () => { closed(); },
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`${origin}/api/local/autostart/shutdown`, {
    method: "POST",
    body: "{}",
    headers: { "x-agentbridge-autostart": token },
  });
  assert.equal(response.status, 202);
  await closedPromise;
  assert.equal(bridge.server.listening, false, "the port has to be free for the restarted bridge");
});
