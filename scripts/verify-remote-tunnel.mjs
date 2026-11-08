/**
 * End-to-end check of the Cloudflare remote path: tunnel → bridge → phone page.
 *
 * This is the manual counterpart of the unit tests. It starts a real cloudflared
 * quick tunnel pointed at a real bridge configured the way the DSH plugin
 * configures it, then asks the public hostname to prove the whole chain works —
 * something no unit test can do, because the tunnel is Cloudflare's.
 *
 *   npm run verify:remote
 *
 * Everything it starts is torn down before it exits, including the tunnel.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureAccessKey, findCloudflared, startQuickTunnel } from "../integrations/dsh-phone/lib/tunnel.js";

const port = Number(process.env.AGENTBRIDGE_VERIFY_PORT ?? 8796);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const command = findCloudflared();
if (!command) {
  console.error("cloudflared was not found. Install it with: winget install --id Cloudflare.cloudflared");
  process.exitCode = 1;
  process.exit();
}
console.log(`cloudflared: ${command}`);

const dataDir = mkdtempSync(path.join(tmpdir(), "agentbridge-verify-"));
let tunnel = null;
let bridge = null;

const cleanup = () => {
  if (bridge) {
    try { bridge.kill(); } catch { /* already gone */ }
  }
  if (tunnel) {
    try { process.kill(tunnel.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  tunnel = await startQuickTunnel({
    command,
    origin: `http://127.0.0.1:${port}`,
    dataDir,
    log: (message) => console.log(`[tunnel] ${message}`),
    timeoutMs: 60_000,
  });
  console.log(`public URL: ${tunnel.url}`);

  const accessKey = ensureAccessKey(dataDir);
  bridge = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      AGENTBRIDGE_PORT: String(port),
      AGENTBRIDGE_DATA_DIR: dataDir,
      AGENTBRIDGE_PUBLIC_ORIGIN: tunnel.url,
      AGENTBRIDGE_ACCESS_KEY: accessKey,
      AGENTBRIDGE_AUTOSTART: "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let local = null;
  for (let attempt = 0; attempt < 40 && !local; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) local = await response.json();
    } catch {
      // Still starting.
    }
  }
  if (!local) throw new Error("the bridge never answered on loopback");
  console.log(`local health: ${JSON.stringify(local)}`);

  // Cloudflare needs a few seconds before the hostname serves the origin.
  let remote = null;
  for (let attempt = 0; attempt < 40 && !remote; attempt += 1) {
    await sleep(1_000);
    try {
      const response = await fetch(`${tunnel.url}/api/health`, { signal: AbortSignal.timeout(8_000) });
      if (response.ok) remote = await response.json();
    } catch {
      // Edge not routing yet.
    }
  }
  if (!remote) throw new Error("Cloudflare never served the bridge; the quick tunnel may be blocked on this network");
  console.log(`health through Cloudflare: ${JSON.stringify(remote)}`);

  const shell = await fetch(`${tunnel.url}/`, { signal: AbortSignal.timeout(10_000) });
  console.log(`app shell through Cloudflare: ${shell.status}`);

  const pairingResponse = await fetch(`http://127.0.0.1:${port}/api/local/phone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: process.cwd(), adapterId: "echo", title: "remote verification" }),
  });
  const registration = await pairingResponse.json();
  const pairingUrl = registration?.pairing?.url;
  console.log(`pairing URL: ${pairingUrl}`);
  if (!pairingUrl || !pairingUrl.startsWith(tunnel.url)) {
    throw new Error("the pairing URL does not point at the public tunnel hostname");
  }
  if (!pairingUrl.includes("key=")) {
    throw new Error("a publicly exposed bridge must hand out its pairing URL with the access key");
  }

  const page = await fetch(pairingUrl, { signal: AbortSignal.timeout(10_000) });
  if (!page.ok) throw new Error(`the pairing page returned ${page.status} through Cloudflare`);
  console.log(`pair page through Cloudflare: ${page.status}`);
  console.log("\nOK: phone-side pairing works over the public address.");
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
