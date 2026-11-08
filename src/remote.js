/**
 * Which network path a QR code should point at.
 *
 * There is more than one way to put a local bridge in front of a phone, and they
 * differ in what they cost the user: a Cloudflare quick tunnel needs nothing on
 * the phone but hands out a random hostname; Tailscale Funnel is a fixed hostname
 * and still needs nothing on the phone; Tailscale and ZeroTier private addresses
 * are the safest but require an app on the phone and a login.
 *
 * So the choice is data, not `if` statements scattered across the CLI and the DSH
 * plugin: each path is a provider with the same shape, and one resolver walks them
 * in a documented order. Everything that touches the machine (running `tailscale`,
 * reading adapters, downloading cloudflared) is injectable, because this module
 * decides whether a public address exists at all.
 */
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ensureAccessKey,
  ensureCloudflared,
  findCloudflared,
  readTunnelState,
  startQuickTunnel,
  tunnelStatePath,
} from "./tunnel.js";

/** Run one command and collect its output instead of streaming it. */
export function runCommand(command, args, { timeoutMs = 15_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      return resolve({ code: null, stdout: "", stderr: String(error?.message ?? error), missing: true });
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once?.("error", (error) => finish({ code: null, stdout, stderr, stderr: String(error?.message ?? error), missing: true }));
    child.once?.("exit", (code) => finish({ code, stdout, stderr }));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tailscale: shared detection for the private-address and Funnel providers
// ---------------------------------------------------------------------------

export function tailscaleCandidates(env = process.env) {
  const candidates = [];
  if (env.AGENTBRIDGE_TAILSCALE) candidates.push(env.AGENTBRIDGE_TAILSCALE);
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "Tailscale", "tailscale.exe"));
  if (env["ProgramFiles(x86)"]) candidates.push(path.join(env["ProgramFiles(x86)"], "Tailscale", "tailscale.exe"));
  candidates.push("/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale");
  candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  return candidates;
}

export function findTailscale({ env = process.env, exists = existsSync } = {}) {
  if (env.AGENTBRIDGE_TAILSCALE) return exists(env.AGENTBRIDGE_TAILSCALE) ? env.AGENTBRIDGE_TAILSCALE : null;
  for (const candidate of tailscaleCandidates(env)) {
    // A bare command name is resolved by the shell, not the filesystem.
    if (!path.isAbsolute(candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return "tailscale";
}

/** The 100.64/10 address Tailscale assigned this node, if it is up. */
export function tailscaleIpv4(status) {
  const addresses = Array.isArray(status?.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [];
  return addresses.find((address) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(address))) ?? null;
}

export function tailscaleDnsName(status) {
  const name = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
  return name || null;
}

/**
 * Ask Tailscale what it is doing.
 *
 * `BackendState` is the interesting field: "Running" means the node is up and on
 * a tailnet. "NeedsLogin" and "Stopped" are the two states users actually hit,
 * and they deserve different advice, so they are reported separately rather than
 * collapsing into "not available".
 */
export async function detectTailscale({ env = process.env, run = runCommand, exists = existsSync } = {}) {
  const bin = findTailscale({ env, exists });
  if (!bin) return { available: false, reason: "Tailscale is not installed", bin: null };
  const result = await run(bin, ["status", "--json"]);
  if (result.missing) return { available: false, reason: "Tailscale is not installed", bin };
  if (result.code !== 0) {
    const detail = `${result.stderr || result.stdout}`.trim();
    const needsOperator = /access denied|permission|operator/i.test(detail);
    return {
      available: false,
      bin,
      reason: needsOperator
        ? "this Windows user cannot read Tailscale status; run `tailscale set --operator=%USERNAME%` once, or start DSH as administrator"
        : `tailscale status failed: ${detail || `exit ${result.code}`}`,
    };
  }
  const status = parseJson(result.stdout);
  if (!status) return { available: false, bin, reason: "Tailscale returned unreadable status" };
  const state = String(status.BackendState ?? "");
  if (state !== "Running") {
    return {
      available: false,
      bin,
      status,
      reason: state === "NeedsLogin"
        ? "Tailscale is installed but not signed in; open its tray app and log in"
        : `Tailscale is not running (${state || "unknown"})`,
    };
  }
  return { available: true, bin, status, ipv4: tailscaleIpv4(status), dnsName: tailscaleDnsName(status) };
}

function tailscaleProvider({ id, label, isPublic }) {
  return {
    id,
    label,
    isPublic,
    async probe(ctx) {
      const found = await detectTailscale({ env: ctx.env, run: ctx.run, exists: ctx.exists });
      return found.available ? { ready: true, detail: found } : { ready: false, reason: found.reason, detail: found };
    },
    async ensure(ctx, probed) {
      const found = probed.detail;
      if (!found?.ipv4) {
        throw new Error("Tailscale is running but has no 100.64/10 address yet");
      }
      return { origin: `http://${found.ipv4}:${ctx.port}`, detail: `Tailscale ${found.ipv4}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Tailscale Funnel: fixed public hostname, nothing to install on the phone
// ---------------------------------------------------------------------------

export const funnelProvider = {
  id: "funnel",
  label: "Tailscale Funnel（固定域名）",
  isPublic: true,
  async probe(ctx) {
    const found = await detectTailscale({ env: ctx.env, run: ctx.run, exists: ctx.exists });
    if (!found.available) return { ready: false, reason: found.reason };
    if (!found.dnsName) return { ready: false, reason: "Tailscale has not assigned this node a DNS name yet" };
    const status = await ctx.run(found.bin, ["funnel", "status"]);
    const text = `${status.stdout}${status.stderr}`;
    // `funnel status` prints "No funnel configuration" when nothing is exposed.
    const enabled = status.code === 0 && !/no funnel|not enabled|no configuration/i.test(text);
    if (enabled) return { ready: true, detail: found };
    if (!ctx.allowEnable) {
      return { ready: false, reason: "Funnel is not enabled for this node (set AGENTBRIDGE_REMOTE=funnel to turn it on)" };
    }
    return { ready: true, needsEnable: true, detail: found };
  },
  async ensure(ctx, probed) {
    const found = probed.detail;
    if (probed.needsEnable) {
      const start = await ctx.run(found.bin, ["funnel", "--bg", "--https=443", `http://127.0.0.1:${ctx.port}`]);
      if (start.code !== 0) {
        const text = `${start.stderr}${start.stdout}`.trim();
        const hint = /not enabled|Funnel is not|enable/i.test(text)
          ? " — enable Funnel for this tailnet in the Tailscale admin console (Access controls → Funnel)"
          : "";
        throw new Error(`tailscale funnel failed: ${text || `exit ${start.code}`}${hint}`);
      }
    }
    return { origin: `https://${found.dnsName}`, detail: `Tailscale Funnel ${found.dnsName}` };
  },
};

// ---------------------------------------------------------------------------
// ZeroTier: private address, app required on the phone
// ---------------------------------------------------------------------------

export function zerotierAddress(interfaces = os.networkInterfaces()) {
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!/zerotier/i.test(name)) continue;
    for (const entry of entries ?? []) {
      if ((entry.family !== "IPv4" && entry.family !== 4) || entry.internal) continue;
      if (!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(entry.address)) continue;
      return { address: entry.address, name };
    }
  }
  return null;
}

export const zerotierProvider = {
  id: "zerotier",
  label: "ZeroTier（私有网络）",
  isPublic: false,
  async probe(ctx) {
    const override = String(ctx.env.AGENTBRIDGE_ZEROTIER ?? "").trim();
    if (override) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(override)) {
        return { ready: false, reason: `AGENTBRIDGE_ZEROTIER is not an IPv4 address: ${override}` };
      }
      return { ready: true, detail: { address: override, name: "AGENTBRIDGE_ZEROTIER" } };
    }
    const found = zerotierAddress(ctx.interfaces ?? os.networkInterfaces());
    if (!found) {
      return { ready: false, reason: "no ZeroTier adapter with a managed IPv4 address (join a network and authorize this member)" };
    }
    return { ready: true, detail: found };
  },
  async ensure(ctx, probed) {
    return { origin: `http://${probed.detail.address}:${ctx.port}`, detail: `ZeroTier ${probed.detail.address}` };
  },
};

// ---------------------------------------------------------------------------
// Cloudflare: quick tunnel (random hostname) and named tunnel (your domain)
// ---------------------------------------------------------------------------

export const cloudflareProvider = {
  id: "cloudflare",
  label: "Cloudflare quick tunnel（自动）",
  isPublic: true,
  async probe(ctx) {
    const command = findCloudflared({ env: ctx.env, home: ctx.home, exists: ctx.exists });
    if (command) return { ready: true, detail: command };
    if (ctx.env.AGENTBRIDGE_NO_DOWNLOAD === "1") {
      return { ready: false, reason: "cloudflared is missing and AGENTBRIDGE_NO_DOWNLOAD=1 forbids fetching it" };
    }
    const downloaded = await ensureCloudflared({ dataDir: ctx.dataDir, env: ctx.env, log: ctx.log });
    if (!downloaded) return { ready: false, reason: "cloudflared is missing and could not be downloaded" };
    return { ready: true, detail: downloaded };
  },
  async ensure(ctx, probed) {
    const tunnel = await startQuickTunnel({
      command: probed.detail,
      origin: `http://127.0.0.1:${ctx.port}`,
      dataDir: ctx.dataDir,
      log: ctx.log,
    });
    return { origin: tunnel.url, detail: tunnel.reused ? "Cloudflare quick tunnel (reused)" : "Cloudflare quick tunnel" };
  },
};

function namedTunnelStatePath(dataDir) {
  return path.join(dataDir, "cloudflare-named-tunnel.json");
}

export const namedTunnelProvider = {
  id: "named",
  label: "Cloudflare 命名隧道（固定域名）",
  isPublic: true,
  async probe(ctx) {
    const name = String(ctx.env.AGENTBRIDGE_CLOUDFLARE_TUNNEL ?? "").trim();
    const hostname = String(ctx.env.AGENTBRIDGE_CLOUDFLARE_HOSTNAME ?? "").trim();
    if (!name) return { ready: false, reason: "AGENTBRIDGE_CLOUDFLARE_TUNNEL is not set" };
    if (!hostname) return { ready: false, reason: "AGENTBRIDGE_CLOUDFLARE_TUNNEL needs AGENTBRIDGE_CLOUDFLARE_HOSTNAME" };
    const command = findCloudflared({ env: ctx.env, home: ctx.home, exists: ctx.exists });
    if (!command) return { ready: false, reason: "cloudflared is missing" };
    return { ready: true, detail: { command, name, origin: `https://${hostname.replace(/^https?:\/\//, "").replace(/\/$/, "")}` } };
  },
  async ensure(ctx, probed) {
    const { command, name, origin } = probed.detail;
    const statePath = namedTunnelStatePath(ctx.dataDir);
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      previous = null;
    }
    const alive = previous && Number.isInteger(previous.pid) && (() => {
      try {
        process.kill(previous.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    })();
    if (alive && previous.tunnel === name) return { origin, detail: `Cloudflare named tunnel ${name} (reused)` };

    const child = spawn(command, ["tunnel", "--no-autoupdate", "run", name], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) {
      try {
        writeFileSync(statePath, JSON.stringify({ pid: child.pid, tunnel: name, origin, startedAt: new Date().toISOString() }, null, 2), "utf8");
      } catch {
        // The record only saves a respawn; the tunnel works either way.
      }
    }
    // cloudflared needs a moment before the edge can route the hostname, and the
    // bridge is about to be started with this origin baked in.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await ctx.fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) });
        return { origin, detail: `Cloudflare named tunnel ${name}` };
      } catch {
        // Edge not routing yet, or the bridge is not up — both are expected now.
      }
    }
    return { origin, detail: `Cloudflare named tunnel ${name}` };
  },
};

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = ["named", "funnel", "cloudflare", "tailscale", "zerotier"];

const PROVIDERS = {
  named: namedTunnelProvider,
  funnel: funnelProvider,
  cloudflare: cloudflareProvider,
  tailscale: tailscaleProvider({ id: "tailscale", label: "Tailscale（私有网络）", isPublic: false }),
  zerotier: zerotierProvider,
};

/**
 * `auto` is deliberately not "try the fanciest thing first".
 *
 * A named tunnel is only in the list when the user configured one, and Funnel is
 * only *reused* in auto mode — turning it on changes the user's tailnet, so that
 * has to be an explicit choice (`AGENTBRIDGE_REMOTE=funnel`). The quick tunnel
 * comes next because it needs nothing from anyone, and the private overlays come
 * last: they are safer, but they require an app on the phone, which is exactly
 * what most people are trying to avoid.
 */
export const AUTO_ORDER = ["named", "funnel", "cloudflare", "tailscale", "zerotier"];

export function parseMode(env = process.env) {
  const raw = String(env.AGENTBRIDGE_REMOTE ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "lan" || raw === "local" || raw === "off" || raw === "none") return "lan";
  return PROVIDER_IDS.includes(raw) ? raw : "auto";
}

/**
 * The public or overlay address the QR code should carry, or null for the LAN.
 *
 * Returns the provider that won, because "which path am I on" is the first thing
 * anyone asks when the QR code does not open.
 */
export async function resolveRemote({
  env = process.env,
  dataDir,
  port = String(env.AGENTBRIDGE_PORT ?? "8787"),
  log = () => {},
  mode = parseMode(env),
  providers = PROVIDERS,
  run = runCommand,
  fetchImpl = globalThis.fetch,
  exists = existsSync,
  home = os.homedir(),
  interfaces,
} = {}) {
  const explicit = String(env.AGENTBRIDGE_PUBLIC_ORIGIN ?? "").trim().replace(/\/$/, "");
  if (explicit) {
    return { provider: "explicit", label: "AGENTBRIDGE_PUBLIC_ORIGIN", origin: explicit, accessKey: null, isPublic: !/^http:\/\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(explicit) };
  }
  const supplied = String(env.AGENTBRIDGE_TUNNEL_URL ?? "").trim().replace(/\/$/, "");
  if (supplied) {
    return { provider: "tunnel-url", label: "AGENTBRIDGE_TUNNEL_URL", origin: supplied, accessKey: ensureAccessKey(dataDir), isPublic: true };
  }
  if (mode === "lan" || env.AGENTBRIDGE_NO_TUNNEL === "1") {
    const why = env.AGENTBRIDGE_NO_TUNNEL === "1" ? "AGENTBRIDGE_NO_TUNNEL=1" : `AGENTBRIDGE_REMOTE=${mode}`;
    log(`${why}: the QR code will work on this Wi-Fi and nowhere else`);
    return null;
  }

  const order = mode === "auto" ? AUTO_ORDER : [mode];
  const reasons = [];
  for (const id of order) {
    const provider = providers[id];
    if (!provider) continue;
    const ctx = { env, dataDir, port, log, run, fetch: fetchImpl, exists, home, interfaces, allowEnable: mode === id };
    let probed;
    try {
      probed = await provider.probe(ctx);
    } catch (error) {
      reasons.push(`${id}: ${error?.message ?? error}`);
      continue;
    }
    if (!probed?.ready) {
      reasons.push(`${id}: ${probed?.reason ?? "not available"}`);
      continue;
    }
    try {
      const result = await provider.ensure(ctx, probed);
      log(`${provider.label} → ${result.origin}`);
      return {
        provider: id,
        label: provider.label,
        origin: result.origin,
        detail: result.detail,
        // Anything reachable from the internet gets the key gate, no exceptions.
        accessKey: provider.isPublic ? ensureAccessKey(dataDir) : null,
        isPublic: provider.isPublic,
      };
    } catch (error) {
      reasons.push(`${id}: ${error?.message ?? error}`);
      continue;
    }
  }

  // Every path was tried and refused. Say why, once, instead of silently
  // pretending the LAN is what the user asked for.
  if (mode !== "auto" || reasons.length) {
    log(`no remote path could be brought up, staying on this Wi-Fi only: ${reasons.join("; ")}`);
  }
  return null;
}

/** Forget the named-tunnel record so the next run starts cloudflared again. */
export function forgetNamedTunnel(dataDir) {
  try {
    rmSync(namedTunnelStatePath(dataDir), { force: true });
  } catch {
    // Nothing to forget.
  }
}

export { tunnelStatePath };
