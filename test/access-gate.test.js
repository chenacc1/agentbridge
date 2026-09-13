import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createBridge, hasAccessKey } from "../src/server.js";
import { loadConfig } from "../src/config.js";

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function remoteRequest({ key = null, cookie = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const url = new URL(`http://bridge.example/api/state${key ? `?key=${encodeURIComponent(key)}` : ""}`);
  return [{ socket: { remoteAddress: "203.0.113.10" }, headers }, url];
}

test("hasAccessKey exempts loopback and accepts key via query, header, or cookie", () => {
  const config = { accessKey: "gate-key" };
  const noKey = remoteRequest();
  assert.equal(hasAccessKey(...noKey, config), false);
  assert.equal(hasAccessKey(...remoteRequest({ key: "wrong" }), config), false);
  assert.equal(hasAccessKey(...remoteRequest({ key: "gate-key" }), config), true);
  assert.equal(hasAccessKey(...remoteRequest({ cookie: "agentbridge_key=gate-key" }), config), true);

  const headered = remoteRequest();
  headered[0].headers["x-agentbridge-key"] = "gate-key";
  assert.equal(hasAccessKey(headered[0], headered[1], config), true);

  const loopback = remoteRequest();
  loopback[0].socket.remoteAddress = "127.0.0.1";
  assert.equal(hasAccessKey(...loopback, config), true);

  assert.equal(hasAccessKey(...noKey, { accessKey: null }), true);
});

test("loadConfig reads AGENTBRIDGE_ACCESS_KEY and defaults to null", () => {
  assert.equal(loadConfig({ AGENTBRIDGE_ACCESS_KEY: "  secret  " }).accessKey, "secret");
  assert.equal(loadConfig({}).accessKey, null);
});

test("access endpoint, gated pairing URL, and device lifecycle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-access-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    accessKey: "gate-key",
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Test machine",
  };
  const bridge = await createBridge({ config });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const wrongKey = await fetch(`${origin}/api/access`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ key: "nope" }),
  });
  assert.equal(wrongKey.status, 401);

  const rightKey = await fetch(`${origin}/api/access`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ key: "gate-key" }),
  });
  assert.equal(rightKey.status, 200);
  assert.match(rightKey.headers.get("set-cookie"), /^agentbridge_key=gate-key/);
  assert.match(rightKey.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);

  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.match(bootstrap.pairing.url, /[?&]key=gate-key/);

  // Desktop session lists devices and revokes the phone.
  const desktopLogin = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const desktopCookie = cookieFrom(desktopLogin);

  const phoneLogin = await fetch(`${origin}/api/pairings/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: bootstrap.pairing.id, deviceName: "Phone" }),
  });
  assert.equal(phoneLogin.status, 201);
  const phoneCookie = cookieFrom(phoneLogin);
  const phoneDevice = (await phoneLogin.json()).device;

  const devicesBefore = await (await fetch(`${origin}/api/devices`, { headers: { cookie: desktopCookie } })).json();
  assert.equal(devicesBefore.devices.length, 2);
  assert.equal(devicesBefore.devices.some((device) => device.id === phoneDevice.id), true);

  const revoke = await fetch(`${origin}/api/devices/${encodeURIComponent(phoneDevice.id)}/revoke`, {
    method: "POST",
    headers: { origin, cookie: desktopCookie },
  });
  assert.equal(revoke.status, 200);

  const revokedState = await fetch(`${origin}/api/state`, { headers: { cookie: phoneCookie } });
  assert.equal(revokedState.status, 401);

  const devicesAfter = await (await fetch(`${origin}/api/devices`, { headers: { cookie: desktopCookie } })).json();
  assert.equal(devicesAfter.devices.length, 1);

  const missing = await fetch(`${origin}/api/devices/${encodeURIComponent(phoneDevice.id)}/revoke`, {
    method: "POST",
    headers: { origin, cookie: desktopCookie },
  });
  assert.equal(missing.status, 404);
});
