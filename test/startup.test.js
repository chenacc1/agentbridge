import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Windows launcher health-checks, prevents duplicate starts, and waits for readiness", async () => {
  const launcher = await readFile(new URL("../scripts/start-agentbridge.ps1", import.meta.url), "utf8");
  const installer = await readFile(new URL("../scripts/install-agentbridge-shortcut.ps1", import.meta.url), "utf8");
  const shortcut = await readFile(new URL("../启动 AgentBridge.cmd", import.meta.url), "utf8");
  const remoteShortcut = await readFile(new URL("../启动 AgentBridge 远程模式.cmd", import.meta.url), "utf8");

  assert.match(launcher, /api\/health/);
  assert.match(launcher, /Get-NetTCPConnection/);
  assert.match(launcher, /Start-Process/);
  assert.match(launcher, /RedirectStandardError/);
  assert.match(launcher, /command\.Definition/);
  assert.match(launcher, /\[switch\]\$Tailscale/);
  assert.match(launcher, /tailscale[^\r\n]*status[^\r\n]*--json/i);
  assert.match(launcher, /tailscale[^\r\n]*ip[^\r\n]*-4/i);
  assert.match(launcher, /tailscale set --operator=/i);
  assert.match(launcher, /AGENTBRIDGE_PUBLIC_ORIGIN/);
  assert.match(launcher, /AGENTBRIDGE_HOST\s*=\s*"0\.0\.0\.0"/);
  assert.match(launcher, /Stop-Process/);
  assert.match(installer, /CreateShortcut/);
  assert.match(installer, /start-agentbridge\.ps1/i);
  assert.match(installer, /AgentBridge Remote\.lnk/);
  assert.match(shortcut, /start-agentbridge\.ps1/i);
  assert.match(remoteShortcut, /-Tailscale/i);
});
