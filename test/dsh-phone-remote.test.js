import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "../integrations/dsh-phone/lib/index.js";

/**
 * A stand-in bridge that behaves like the real one where the remote switch cares:
 * it reports what address it advertises, whether it was autostarted, and it can be
 * asked to stop on loopback.
 */
const STUB = `
import { createServer } from "node:http";
const port = Number(process.env.AGENTBRIDGE_PORT);
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") {
    return res.end(JSON.stringify({
      ok: true,
      advertisedOrigin: process.env.AGENTBRIDGE_PUBLIC_ORIGIN || "http://127.0.0.1:" + port,
      accessKeyRequired: Boolean(process.env.AGENTBRIDGE_ACCESS_KEY),
      autostart: process.env.AGENTBRIDGE_AUTOSTART === "1",
    }));
  }
  if (req.url === "/api/local/shutdown") {
    res.end(JSON.stringify({ accepted: true }));
    setImmediate(() => { server.close(); process.exit(0); });
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});
server.listen(port, "127.0.0.1");
setTimeout(() => process.exit(0), 30_000).unref();
`;

function context() {
  return {
    on() {},
    commands: { register() {} },
    apiProxy: { sessions: { async models() { throw new Error("unused"); } } },
    logger: { warn() {} },
  };
}

async function waitForHealth(port, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      last = await response.json();
      if (predicate(last)) return last;
    } catch {
      // Bridge is mid-restart.
    }
  }
  throw new Error(`bridge never reached the expected state; last health was ${JSON.stringify(last)}`);
}

test("the plugin puts the bridge on the public address and keeps the access key on", async (t) => {
  const saved = {
    origin: process.env.AGENTBRIDGE_ORIGIN,
    entry: process.env.AGENTBRIDGE_BRIDGE_ENTRY,
    dataDir: process.env.AGENTBRIDGE_DATA_DIR,
    tunnel: process.env.AGENTBRIDGE_TUNNEL_URL,
    noAutostart: process.env.AGENTBRIDGE_NO_AUTOSTART,
    noTunnel: process.env.AGENTBRIDGE_NO_TUNNEL,
  };
  delete process.env.AGENTBRIDGE_NO_AUTOSTART;
  delete process.env.AGENTBRIDGE_NO_TUNNEL;

  const port = 19300 + Math.floor(Math.random() * 80);
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-remote-"));
  const stub = path.join(dir, "server.mjs");
  await writeFile(stub, STUB, "utf8");

  process.env.AGENTBRIDGE_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.AGENTBRIDGE_BRIDGE_ENTRY = stub;
  process.env.AGENTBRIDGE_DATA_DIR = path.join(dir, "state");
  process.env.AGENTBRIDGE_TUNNEL_URL = "https://first-tunnel.example";

  t.after(async () => {
    for (const [key, value] of Object.entries({
      AGENTBRIDGE_ORIGIN: saved.origin,
      AGENTBRIDGE_BRIDGE_ENTRY: saved.entry,
      AGENTBRIDGE_DATA_DIR: saved.dataDir,
      AGENTBRIDGE_TUNNEL_URL: saved.tunnel,
      AGENTBRIDGE_NO_AUTOSTART: saved.noAutostart,
      AGENTBRIDGE_NO_TUNNEL: saved.noTunnel,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  apply(context());

  const first = await waitForHealth(port, (health) => health.advertisedOrigin === "https://first-tunnel.example");
  assert.equal(first.accessKeyRequired, true, "a public URL without the access key would be open to the internet");
  assert.equal(first.autostart, true);

  // A second load with a new address must move the bridge, which is the case a
  // desktop restart hits: the previous bridge is still running and healthy, but
  // it advertises an address that no longer exists.
  process.env.AGENTBRIDGE_TUNNEL_URL = "https://second-tunnel.example";
  apply(context());

  const second = await waitForHealth(port, (health) => health.advertisedOrigin === "https://second-tunnel.example");
  assert.equal(second.accessKeyRequired, true);
  assert.equal(second.autostart, true);
});
