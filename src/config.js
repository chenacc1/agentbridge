import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Adapter names that never reach the phone, or only reach it over an overlay.
 *
 * A Windows laptop normally carries several phantom adapters: Hyper-V switches,
 * WSL, "本地连接*" (Wi-Fi Direct), Bluetooth PAN and — with Tailscale installed
 * but logged out — a 169.254.x.x link-local fallback. `os.networkInterfaces()`
 * returns them in no meaningful order, so taking the first one can hand the
 * phone an address with no route to anything. That is exactly what shipped in
 * 0.1.0: the QR encoded the logged-out Tailscale adapter.
 */
const OVERLAY_ADAPTER_HINTS = ["tailscale", "zerotier", "wireguard", "hamachi", "radmin", "vpn"];
const VIRTUAL_ADAPTER_HINTS = [
  "vethernet", "hyper-v", "wsl", "vmware", "virtualbox", "docker", "npcap",
  "loopback", "bluetooth", "蓝牙", "wi-fi direct", "wifi direct", "tap-", "utun",
];
const PHYSICAL_ADAPTER_HINTS = ["wlan", "wi-fi", "wifi", "无线", "ethernet", "以太网", "en0", "eth", "enp", "ens", "本地连接"];

/**
 * How usable an address is from another device, 0 meaning "not at all".
 *
 * Loopback and 169.254 link-local are hard zeros: a link-local address means the
 * adapter never got a lease, so nothing outside the cable can reach it. Private
 * RFC 1918 ranges are the intended path, 100.64/10 (Tailscale's CGNAT range) is
 * reachable only from a phone that is also on the tailnet, and a plain public
 * address on a NIC still beats nothing.
 */
function addressScore(address) {
  const [a, b] = address.split(".").map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return 0;
  if (a === 0 || a === 127 || a >= 224) return 0;
  if (a === 169 && b === 254) return 0;
  if (a === 192 && b === 168) return 100;
  if (a === 10) return 95;
  if (a === 172 && b >= 16 && b <= 31) return 90;
  if (a === 100 && b >= 64 && b <= 127) return 60;
  return 50;
}

function adapterScore(name = "") {
  const lower = String(name).toLowerCase();
  // Hosted-network names such as "本地连接* 10" carry an asterisk; the star is what
  // distinguishes them from the plain "本地连接" of a real Ethernet card.
  if (lower.includes("*")) return -120;
  if (OVERLAY_ADAPTER_HINTS.some((hint) => lower.includes(hint))) return -40;
  if (VIRTUAL_ADAPTER_HINTS.some((hint) => lower.includes(hint))) return -120;
  if (PHYSICAL_ADAPTER_HINTS.some((hint) => lower.includes(hint))) return 25;
  return 0;
}

/**
 * Every IPv4 address a phone could plausibly open, best first.
 *
 * Exported for tests: the failure this guards against depends on the machine's
 * adapter list, which no CI runner reproduces.
 */
export function rankLanAddresses(interfaces = os.networkInterfaces()) {
  const ranked = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // `family` is "IPv4" on modern Node and 4 on older builds.
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue;
      // A zero address score is a hard no: a friendly adapter name cannot make a
      // link-local or loopback address routable.
      const score = addressScore(entry.address) + adapterScore(name);
      if (addressScore(entry.address) === 0 || score <= 0) continue;
      ranked.push({ name, address: entry.address, score });
    }
  }
  // A stable sort keeps the OS order for equally scored adapters.
  return ranked.sort((left, right) => right.score - left.score);
}

function firstLanAddress(interfaces) {
  return rankLanAddresses(interfaces)[0]?.address ?? "127.0.0.1";
}

function parseProjects(raw, workspace) {
  if (!raw) return new Map([["workspace", path.resolve(workspace)]]);

  const projects = new Map();
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) throw new Error(`Invalid AGENTBRIDGE_PROJECTS entry: ${part}`);
    const alias = part.slice(0, separator).trim();
    const projectPath = part.slice(separator + 1).trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias) || !projectPath) {
      throw new Error(`Invalid project alias or path: ${part}`);
    }
    projects.set(alias, path.resolve(projectPath));
  }
  if (projects.size === 0) throw new Error("At least one allowed project is required");
  return projects;
}

/**
 * Notification settings can also live in `.agentbridge/notify.json`.
 *
 * Environment variables are awkward to keep on Windows (a double-clicked launcher
 * inherits no shell environment), and a webhook token is a credential that must not
 * end up in a tracked file. The bridge's own data directory is git-ignored, so a
 * small JSON file there is the honest place for it; environment variables still win
 * when both are present, which keeps `setx` and one-off experiments working.
 */
function readNotifyFile(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "notify.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function pick(env, key, fallback) {
  const value = String(env[key] ?? "").trim();
  return value || fallback || null;
}

/** The persisted block, for callers that need to read it directly. */
export function readNotifyConfig(dataDir) {
  return readNotifyFile(dataDir);
}

/**
 * Patch `.agentbridge/notify.json` without losing the rest of it.
 *
 * Written atomically (tmp + rename) because a half-written file after a power loss
 * would silently disable notifications; the merge is what keeps the token intact when
 * only `muted` changes.
 */
export function writeNotifyConfig(dataDir, patch) {
  const next = { ...readNotifyFile(dataDir), ...patch };
  mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, "notify.json");
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
  renameSync(temporary, target);
  return next;
}

export function loadConfig(env = process.env, workspace = process.cwd()) {
  const port = Number.parseInt(env.AGENTBRIDGE_PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTBRIDGE_PORT must be a valid TCP port");
  }

  const host = env.AGENTBRIDGE_HOST ?? "0.0.0.0";
  const publicOrigin = (env.AGENTBRIDGE_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  const advertisedOrigin = publicOrigin || `http://${firstLanAddress()}:${port}`;
  const accessKey = (env.AGENTBRIDGE_ACCESS_KEY ?? "").trim() || null;
  const dataDir = path.resolve(env.AGENTBRIDGE_DATA_DIR ?? path.join(workspace, ".agentbridge"));
  const notifyFile = readNotifyFile(dataDir);

  return {
    host,
    port,
    advertisedOrigin,
    accessKey,
    secureCookies: advertisedOrigin.startsWith("https://"),
    dataDir,
    projects: parseProjects(env.AGENTBRIDGE_PROJECTS, workspace),
    pairingTtlMs: Number.parseInt(env.AGENTBRIDGE_PAIRING_TTL_MS ?? "300000", 10),
    sessionTtlMs: Number.parseInt(env.AGENTBRIDGE_SESSION_TTL_MS ?? "259200000", 10),
    machineName: env.AGENTBRIDGE_MACHINE_NAME ?? os.hostname(),
    // Set by the DSH plugin when it spawns the bridge itself. It lets the plugin
    // recognise its own child in /api/health and restart it to change the public
    // address, without ever touching a bridge the user started by hand.
    autostart: env.AGENTBRIDGE_AUTOSTART === "1",
    // Outbound notifications: unset webhook means the feature is simply off.
    notifyWebhook: pick(env, "AGENTBRIDGE_NOTIFY_WEBHOOK", notifyFile.webhook),
    notifyFormat: pick(env, "AGENTBRIDGE_NOTIFY_FORMAT", notifyFile.format ?? "json").toLowerCase(),
    notifyChatId: pick(env, "AGENTBRIDGE_NOTIFY_CHAT_ID", notifyFile.chatId),
    // PushPlus-style services need the token inside the request body.
    notifyToken: pick(env, "AGENTBRIDGE_NOTIFY_TOKEN", notifyFile.token),
    // Some providers (PushPlus) also take a delivery channel, e.g. `clawbot`.
    notifyChannel: pick(env, "AGENTBRIDGE_NOTIFY_CHANNEL", notifyFile.channel),
    // Per-bridge mute, toggled from the phone; persisted so it survives a restart.
    notifyMuted: notifyFile.muted === true,
    // Opt-in: putting the access key into a third-party chat is a real disclosure,
    // so the notification link stays keyless unless the operator asks for it.
    notifyLink: notifyFile.link === true || pick(env, "AGENTBRIDGE_NOTIFY_LINK", null) === "1",
  };
}

/** The URL a notification should offer; never includes the access key by default. */
export function notificationLink(config) {
  if (!config?.advertisedOrigin) return null;
  const base = config.advertisedOrigin;
  if (!config.notifyLink) return base;
  return config.accessKey ? `${base}/?key=${encodeURIComponent(config.accessKey)}` : base;
}

export function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
