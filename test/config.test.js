import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig, isLoopback, rankLanAddresses } from "../src/config.js";

/** Windows adapters in the order that produced a dead QR code in 0.1.0. */
function windowsAdapters() {
  const v4 = (address, internal = false) => [{ family: "IPv4", address, internal, netmask: "255.255.255.0" }];
  return {
    "Loopback Pseudo-Interface 1": [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    Tailscale: v4("169.254.83.107"),
    "vEthernet (Default Switch)": v4("172.29.16.1"),
    "vEthernet (WSL (Hyper-V firewall))": v4("172.17.128.1"),
    WLAN: v4("169.254.88.30"),
    "本地连接* 10": v4("169.254.88.109"),
    "蓝牙网络连接 2": v4("169.254.177.226"),
    "以太网 5": v4("192.168.0.2"),
  };
}

test("LAN ranking skips link-local and virtual adapters", () => {
  const ranked = rankLanAddresses(windowsAdapters());
  assert.equal(ranked[0].address, "192.168.0.2");
  assert.ok(ranked.every((entry) => !entry.address.startsWith("169.254.")));
  assert.ok(ranked.every((entry) => !entry.address.startsWith("127.")));
});

test("LAN ranking prefers Wi-Fi over an overlay adapter with the same address class", () => {
  const v4 = (address) => [{ family: "IPv4", address, internal: false }];
  const ranked = rankLanAddresses({
    Tailscale: v4("100.83.253.5"),
    WLAN: v4("192.168.1.20"),
  });
  assert.deepEqual(ranked.map((entry) => entry.address), ["192.168.1.20", "100.83.253.5"]);
});

test("LAN ranking returns nothing when only loopback and link-local exist", () => {
  const v4 = (address, internal = false) => [{ family: "IPv4", address, internal }];
  const ranked = rankLanAddresses({ Tailscale: v4("169.254.83.107"), "Wi-Fi": v4("127.0.0.1", true) });
  assert.deepEqual(ranked, []);
});

test("config defaults to one allowlisted workspace", () => {
  const root = path.resolve("fixture-workspace");
  const config = loadConfig({ AGENTBRIDGE_PORT: "9999" }, root);
  assert.equal(config.port, 9999);
  assert.equal(config.projects.get("workspace"), root);
  assert.equal(config.sessionTtlMs, 72 * 60 * 60 * 1000);
});

test("config parses project aliases and rejects invalid aliases", () => {
  const config = loadConfig({ AGENTBRIDGE_PROJECTS: "alpha=.\u005capp;docs=.\u005cdocs" }, process.cwd());
  assert.equal(config.projects.size, 2);
  assert.throws(() => loadConfig({ AGENTBRIDGE_PROJECTS: "bad alias=." }), /Invalid project/);
});

test("config advertises an explicit Tailscale origin without changing the local listener", () => {
  const config = loadConfig({
    AGENTBRIDGE_PUBLIC_ORIGIN: "http://100.101.102.103:8787/",
    AGENTBRIDGE_HOST: "0.0.0.0",
  }, process.cwd());
  assert.equal(config.advertisedOrigin, "http://100.101.102.103:8787");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.secureCookies, false);
});

test("loopback detection accepts IPv4 and IPv6 forms", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.2"), false);
});

test("notification settings left in an old data directory are adopted, once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-legacy-notify-"));
  try {
    const legacy = path.join(root, "old", ".agentbridge");
    const current = path.join(root, "new");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, "notify.json"),
      JSON.stringify({ webhook: "https://www.pushplus.plus/send", format: "pushplus", token: "legacy-token" }),
      "utf8",
    );

    const config = loadConfig({ AGENTBRIDGE_DATA_DIR: current, AGENTBRIDGE_NOTIFY_IMPORT: legacy }, root);
    assert.equal(config.notifyWebhook, "https://www.pushplus.plus/send");
    assert.equal(config.notifyToken, "legacy-token");

    // The move is permanent: the new directory owns the settings now, so the next
    // launch does not depend on the old one still existing.
    const adopted = JSON.parse(await readFile(path.join(current, "notify.json"), "utf8"));
    assert.equal(adopted.token, "legacy-token");

    const withoutLegacy = loadConfig({ AGENTBRIDGE_DATA_DIR: current }, root);
    assert.equal(withoutLegacy.notifyToken, "legacy-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings in the current data directory always win over a legacy copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-notify-wins-"));
  try {
    await writeFile(path.join(root, "notify.json"), JSON.stringify({ token: "current-token" }), "utf8");
    const legacy = path.join(root, "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "notify.json"), JSON.stringify({ token: "legacy-token" }), "utf8");

    const config = loadConfig({ AGENTBRIDGE_DATA_DIR: root, AGENTBRIDGE_NOTIFY_IMPORT: legacy }, root);
    assert.equal(config.notifyToken, "current-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
