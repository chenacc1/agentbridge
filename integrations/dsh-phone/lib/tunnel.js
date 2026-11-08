/**
 * Cloudflare quick tunnel, so the phone does not have to share a Wi-Fi with the PC.
 *
 * A LAN-only QR code is a dead end the moment the user leaves the house, and it is
 * also what WeChat likes least (an http URL with a bare IP address in it). A
 * `cloudflared` quick tunnel hands back a real https hostname, which the phone can
 * open from anywhere — at the cost of two honest caveats:
 *
 *  - the hostname is random and changes whenever the tunnel is recreated, so a
 *    phone bookmark only lasts as long as the process keeps running;
 *  - it is a public URL, so the bridge in front of it must keep its access key on.
 *
 * Everything here is deliberately side-effect free until called, and every
 * environment-dependent lookup takes an injectable dependency, because this code
 * decides whether a public URL exists at all and that is worth testing.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A quick tunnel hostname.
 *
 * The negative lookahead is load-bearing: cloudflared's own failure messages quote
 * `https://api.trycloudflare.com/tunnel`, which matches a naive pattern and would
 * be mistaken for the tunnel the phone should open.
 */
export const TUNNEL_URL_PATTERN = /https:\/\/(?!api\.)[-a-z0-9]+\.trycloudflare\.com/;

// cloudflared writes the banner to stderr, but stdout is cheap to read too and
// some builds differ.
export function extractTunnelUrl(text) {
  const match = TUNNEL_URL_PATTERN.exec(String(text ?? ""));
  return match ? match[0] : null;
}

/**
 * Where `cloudflared` usually lives on Windows, best first.
 *
 * PATH is included because `winget` installs a shim there, and the two Program
 * Files directories cover the MSI, which does not touch PATH from a non-elevated
 * shell. `AGENTBRIDGE_CLOUDFLARED` wins over all of it for unusual installs.
 */
export function cloudflaredCandidates(env = process.env, home = os.homedir()) {
  const candidates = [];
  if (env.AGENTBRIDGE_CLOUDFLARED) candidates.push(env.AGENTBRIDGE_CLOUDFLARED);
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, "cloudflared.exe"), path.join(dir, "cloudflared"));
  }
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "cloudflared", "cloudflared.exe"));
  if (env["ProgramFiles(x86)"]) candidates.push(path.join(env["ProgramFiles(x86)"], "cloudflared", "cloudflared.exe"));
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
  // The bridge's own data directory is a last resort for a portable copy the user
  // downloaded by hand.
  candidates.push(path.join(home, ".agentbridge", "bin", "cloudflared.exe"));
  return candidates;
}

export function findCloudflared({ env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  for (const candidate of cloudflaredCandidates(env, home)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable PATH entry is not worth failing the whole search.
    }
  }
  return null;
}

export function accessKeyPath(dataDir) {
  return path.join(dataDir, "access-key");
}

export function autostartTokenPath(dataDir) {
  return path.join(dataDir, "autostart-token");
}

/**
 * The key that gates a publicly exposed bridge.
 *
 * Read before generated, so the value survives restarts: the phone already holds a
 * cookie for it, and regenerating on every launch would silently lock the phone
 * out of its own bridge.
 */
export function ensureAccessKey(dataDir, { readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync, random } = {}) {
  return ensureSecret(accessKeyPath(dataDir), dataDir, { readFile, writeFile, mkdir, random });
}

/**
 * The secret that lets this plugin ask its own bridge to restart.
 *
 * A restart is how the advertised address changes (the tunnel hostname only
 * exists once cloudflared is up), and the bridge accepts that request only from
 * loopback *with this token* — so a random local page cannot stop the bridge, and
 * a second, unrelated DSH profile cannot either.
 */
export function ensureAutostartToken(dataDir, options = {}) {
  return ensureSecret(autostartTokenPath(dataDir), dataDir, options);
}

export function readAutostartToken(dataDir, { readFile = readFileSync } = {}) {
  try {
    return String(readFile(autostartTokenPath(dataDir), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function ensureSecret(target, dataDir, { readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync, random } = {}) {
  try {
    const existing = String(readFile(target, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch {
    // No usable secret on disk yet.
  }
  const secret = (random ?? (() => randomBytes(24).toString("base64url")))();
  mkdir(dataDir, { recursive: true });
  writeFile(target, secret, "utf8");
  return secret;
}

export function tunnelStatePath(dataDir) {
  return path.join(dataDir, "cloudflare-tunnel.json");
}

export function readTunnelState(dataDir, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(String(readFile(tunnelStatePath(dataDir), "utf8")));
    if (!parsed || typeof parsed.url !== "string" || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeTunnelState(dataDir, state, { writeFile = writeFileSync, mkdir = mkdirSync, rename = renameSync } = {}) {
  mkdir(dataDir, { recursive: true });
  const target = tunnelStatePath(dataDir);
  const temporary = `${target}.tmp`;
  writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  rename(temporary, target);
  return state;
}

function isAlive(pid, { kill = process.kill.bind(process) } = {}) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but not ours", which still counts as alive.
    return error?.code === "EPERM";
  }
}

/**
 * Start cloudflared and wait for the hostname it prints.
 *
 * The child is detached on purpose: the tunnel outliving DSH means the URL in an
 * already paired phone keeps working after the desktop restarts, and it also
 * avoids killing the tunnel whenever the Electron host decides to reload.
 *
 * Reuse is keyed on the state file plus a live pid plus a matching origin: a
 * tunnel pointing at the old port would advertise a URL that resolves to a 502.
 */
export async function startQuickTunnel({
  command,
  origin,
  dataDir,
  log = () => {},
  timeoutMs = 40_000,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  kill = process.kill.bind(process),
} = {}) {
  if (!command) throw new Error("cloudflared was not found");
  if (!origin) throw new Error("the tunnel needs an origin to forward to");

  const previous = readTunnelState(dataDir);
  if (previous && previous.origin === origin && isAlive(previous.pid, { kill })) {
    const reachable = await probeTunnel(previous.url, fetchImpl);
    if (reachable) {
      log(`reusing the running Cloudflare tunnel at ${previous.url}`);
      return { ...previous, reused: true };
    }
    log(`the recorded tunnel is no longer answering; starting a new one`);
  }

  const child = spawnImpl(command, ["tunnel", "--no-autoupdate", "--url", origin], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      const tail = output.trim().split(/\r?\n/).slice(-6).join(" | ");
      try {
        kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      finish(new Error(`cloudflared did not announce a hostname within ${Math.round(timeoutMs / 1000)}s${tail ? `: ${tail}` : ""}`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      output += String(chunk);
      const url = extractTunnelUrl(output);
      if (!url) return;
      finish(null, {
        url,
        pid: child.pid,
        origin,
        startedAt: new Date().toISOString(),
      });
    };

    child.stdout?.on?.("data", onData);
    child.stderr?.on?.("data", onData);
    child.once?.("error", (error) => finish(new Error(`cloudflared could not start: ${error.message}`)));
    child.once?.("exit", (code) => {
      const tail = output.trim().split(/\r?\n/).slice(-6).join(" | ");
      finish(new Error(`cloudflared exited with code ${code} before announcing a hostname${tail ? `: ${tail}` : ""}`));
    });
  });

  // The tunnel is meant to outlive this process; the pipes are only for the banner.
  child.unref?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  return writeTunnelState(dataDir, state) && { ...state, reused: false };
}

/**
 * Anything but a transport error means the tunnel exists.
 *
 * A 502 is the normal answer while the local bridge is down, and it still proves
 * Cloudflare's edge knows this hostname.
 */
async function probeTunnel(url, fetchImpl = globalThis.fetch) {
  try {
    await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(6_000) });
    return true;
  } catch {
    return false;
  }
}
