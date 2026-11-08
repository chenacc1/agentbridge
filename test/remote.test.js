import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTO_ORDER,
  parseMode,
  resolveRemote,
  tailscaleIpv4,
  zerotierAddress,
} from "../src/remote.js";

/** A `run` stand-in: match the command line, return canned output. */
function fakeRun(table) {
  const calls = [];
  const run = async (command, args = []) => {
    const line = `${path.basename(command)} ${args.join(" ")}`.trim();
    calls.push(line);
    for (const [pattern, result] of table) {
      if (typeof pattern === "string" && !line.includes(pattern)) continue;
      if (pattern instanceof RegExp && !pattern.test(line)) continue;
      return typeof result === "function" ? result(line) : result;
    }
    return { code: 1, stdout: "", stderr: `no fixture for ${line}` };
  };
  run.calls = calls;
  return run;
}

const TAILSCALE_ONLINE = {
  code: 0,
  stdout: JSON.stringify({
    BackendState: "Running",
    Self: { TailscaleIPs: ["100.83.253.5", "fd7a:115c::1"], DNSName: "desktop-mq3a4tb.tailnet-abc.ts.net.", Online: true },
  }),
  stderr: "",
};

test("the mode is read from the environment and unknown values fall back to auto", () => {
  assert.equal(parseMode({}), "auto");
  assert.equal(parseMode({ AGENTBRIDGE_REMOTE: "auto" }), "auto");
  assert.equal(parseMode({ AGENTBRIDGE_REMOTE: "Funnel" }), "funnel");
  assert.equal(parseMode({ AGENTBRIDGE_REMOTE: "tailscale" }), "tailscale");
  assert.equal(parseMode({ AGENTBRIDGE_REMOTE: "lan" }), "lan");
  assert.equal(parseMode({ AGENTBRIDGE_REMOTE: "nonsense" }), "auto");
});

test("an explicit origin is used as-is and needs no key", async () => {
  const decided = await resolveRemote({ env: { AGENTBRIDGE_PUBLIC_ORIGIN: "https://bridge.example.com/" }, dataDir: "unused" });
  assert.equal(decided.provider, "explicit");
  assert.equal(decided.origin, "https://bridge.example.com");
  assert.equal(decided.accessKey, null);
});

test("LAN-only mode returns nothing without probing a single provider", async () => {
  const run = fakeRun([]);
  const decided = await resolveRemote({ env: { AGENTBRIDGE_REMOTE: "lan" }, dataDir: "unused", run, log: () => {} });
  assert.equal(decided, null);
  assert.deepEqual(run.calls, []);
});

test("providers are tried in order and a failure falls through to the next", async () => {
  const tried = [];
  const providers = Object.fromEntries(AUTO_ORDER.map((id, index) => [id, {
    id,
    label: `label-${id}`,
    isPublic: false,
    async probe() {
      tried.push(id);
      return index < 2 ? { ready: false, reason: `${id} unavailable` } : { ready: true, detail: {} };
    },
    async ensure() {
      return { origin: `http://${id}.test:8787`, detail: id };
    },
  }]));
  const decided = await resolveRemote({ env: {}, dataDir: "unused", providers, log: () => {} });
  assert.deepEqual(tried, ["named", "funnel", "cloudflare"]);
  assert.equal(decided.provider, "cloudflare");
  assert.equal(decided.origin, "http://cloudflare.test:8787");
  assert.equal(decided.accessKey, null, "a private provider must not switch the key gate on");
});

test("anything reachable from the internet is given an access key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-remote-key-"));
  try {
    const providers = {
      cloudflare: {
        id: "cloudflare",
        label: "cf",
        isPublic: true,
        async probe() { return { ready: true, detail: {} }; },
        async ensure() { return { origin: "https://x.trycloudflare.com", detail: "cf" }; },
      },
    };
    const decided = await resolveRemote({ env: {}, dataDir: dir, providers, log: () => {} });
    assert.equal(decided.provider, "cloudflare");
    assert.ok(decided.accessKey && decided.accessKey.length >= 16);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tailscale reports the tailnet address, and explains the two states users hit", async () => {
  assert.equal(tailscaleIpv4({ Self: { TailscaleIPs: ["100.83.253.5"] } }), "100.83.253.5");
  assert.equal(tailscaleIpv4({ Self: { TailscaleIPs: ["192.168.0.2"] } }), null);

  const online = fakeRun([["status --json", TAILSCALE_ONLINE]]);
  const decided = await resolveRemote({
    env: { AGENTBRIDGE_REMOTE: "tailscale", AGENTBRIDGE_TAILSCALE: "C:\\Tailscale\\tailscale.exe" },
    dataDir: "unused",
    port: "8787",
    run: online,
    exists: () => true,
    log: () => {},
  });
  assert.equal(decided.provider, "tailscale");
  assert.equal(decided.origin, "http://100.83.253.5:8787");

  const signedOut = fakeRun([["status --json", { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: {} }), stderr: "" }]]);
  const reasons = [];
  const refused = await resolveRemote({
    env: { AGENTBRIDGE_REMOTE: "tailscale", AGENTBRIDGE_TAILSCALE: "C:\\Tailscale\\tailscale.exe" },
    dataDir: "unused",
    run: signedOut,
    exists: () => true,
    log: (message) => reasons.push(message),
  });
  assert.equal(refused, null);
  assert.ok(reasons.join(" | ").includes("not signed in"), reasons.join(" | "));
});

test("Funnel is reused when it is already on, and only switched on when asked", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-funnel-"));
  try {
    const enabledRun = fakeRun([
      ["status --json", TAILSCALE_ONLINE],
      ["funnel status", { code: 0, stdout: "https://desktop-mq3a4tb.tailnet-abc.ts.net\n|-- / proxy http://127.0.0.1:8787", stderr: "" }],
    ]);
    const reused = await resolveRemote({
      env: { AGENTBRIDGE_REMOTE: "funnel", AGENTBRIDGE_TAILSCALE: "tailscale" },
      dataDir: dir,
      port: "8787",
      run: enabledRun,
      exists: () => true,
      log: () => {},
    });
    assert.equal(reused.provider, "funnel");
    assert.equal(reused.origin, "https://desktop-mq3a4tb.tailnet-abc.ts.net");
    assert.ok(!enabledRun.calls.some((call) => call.includes("--bg")), "an already-exposed node must not be reconfigured");
    assert.ok(reused.accessKey, "a Funnel address is public and must carry the key");

    const offRun = fakeRun([
      ["status --json", TAILSCALE_ONLINE],
      ["funnel status", { code: 1, stdout: "", stderr: "No funnel configuration" }],
      ["funnel --bg", { code: 0, stdout: "", stderr: "" }],
    ]);
    const enabled = await resolveRemote({
      env: { AGENTBRIDGE_REMOTE: "funnel", AGENTBRIDGE_TAILSCALE: "tailscale" },
      dataDir: dir,
      port: "8787",
      run: offRun,
      exists: () => true,
      log: () => {},
    });
    assert.equal(enabled.provider, "funnel");
    assert.ok(offRun.calls.some((call) => call.includes("funnel --bg --https=443 http://127.0.0.1:8787")), offRun.calls.join(" | "));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto mode does not switch Funnel on behind the user's back", async () => {
  const run = fakeRun([
    ["status --json", TAILSCALE_ONLINE],
    ["funnel status", { code: 1, stdout: "", stderr: "No funnel configuration" }],
  ]);
  const providers = {
    funnel: (await import("../src/remote.js")).funnelProvider,
  };
  const decisions = [];
  const decided = await resolveRemote({
    env: { AGENTBRIDGE_REMOTE: "auto", AGENTBRIDGE_TAILSCALE: "tailscale" },
    dataDir: "unused",
    mode: "auto",
    providers,
    run,
    exists: () => true,
    log: (message) => decisions.push(message),
  });
  assert.equal(decided, null, "with only Funnel available in auto mode, nothing should be enabled");
  assert.ok(!run.calls.some((call) => call.includes("--bg")));
});

test("ZeroTier is found from the adapter the phone would also reach", () => {
  const found = zerotierAddress({
    "以太网 5": [{ family: "IPv4", address: "192.168.0.2", internal: false }],
    "ZeroTier One [8056c2e21c000001]": [{ family: "IPv4", address: "10.147.20.15", internal: false }],
  });
  assert.equal(found?.address, "10.147.20.15");
  assert.equal(zerotierAddress({ "以太网 5": [{ family: "IPv4", address: "192.168.0.2", internal: false }] }), null);
});

test("a named Cloudflare tunnel needs both a tunnel and a hostname", async () => {
  const { namedTunnelProvider } = await import("../src/remote.js");
  const ctx = { env: {}, exists: () => true, home: "C:\\Users\\me" };
  const missingName = await namedTunnelProvider.probe(ctx);
  assert.equal(missingName.ready, false);
  assert.match(missingName.reason, /AGENTBRIDGE_CLOUDFLARE_TUNNEL/);

  const missingHost = await namedTunnelProvider.probe({
    ...ctx,
    env: { AGENTBRIDGE_CLOUDFLARE_TUNNEL: "bridge", AGENTBRIDGE_CLOUDFLARED: "C:\\cloudflared.exe" },
  });
  assert.equal(missingHost.ready, false);
  assert.match(missingHost.reason, /AGENTBRIDGE_CLOUDFLARE_HOSTNAME/);
});
