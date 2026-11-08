import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parseMode, resolveRemote } from "./remote.js";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(sourceDir, "..");
const cliEntry = path.join(bridgeRoot, "bin", "agentbridge.js");

export function parseCliArguments(argv) {
  const command = argv[0]?.startsWith("-") ? "phone" : argv.shift() ?? "phone";
  const options = {};
  if (command === "setup" && argv[0] && !argv[0].startsWith("-")) {
    options.target = argv.shift().toLowerCase();
  }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (["json", "no-start", "user", "project", "help"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

export function renderClaudePhoneSkill(entryPath = cliEntry) {
  const portableEntry = entryPath.replaceAll("\\", "/").replaceAll('"', '\\"');
  return `---
name: phone
description: Generate a one-time WeChat QR code bound to this exact Claude Code conversation and project directory.
disable-model-invocation: true
allowed-tools: Bash(node "${portableEntry}" phone --agent claude --session * --cwd .)
---

# Send this Claude conversation to AgentBridge

Generate a short-lived QR code for the current conversation. The command output is authoritative; reproduce it without changing the URL or QR layout.

!\`node "${portableEntry}" phone --agent claude --session "\${CLAUDE_SESSION_ID}" --cwd .\`

Tell the user to scan the QR with WeChat. While the phone controls this session, keep this terminal idle so messages do not interleave.
`;
}

export function renderCodexPhoneSkill(entryPath = cliEntry) {
  const portableEntry = entryPath.replaceAll("\\", "/").replaceAll('"', '\\"');
  return `---
name: phone
description: Generate a one-time WeChat QR code for a Codex project conversation. Use only when the user explicitly invokes /phone.
disable-model-invocation: true
---

# Send a Codex project to AgentBridge

When the user invokes \`/phone\`, you must immediately execute the following command in the terminal from the current project directory. Do not merely describe the command or ask the user to run it:

\`node "${portableEntry}" phone --agent codex --cwd .\`

After a successful command, reply with the exact QR image Markdown emitted by the command (for example, \`![微信扫码二维码](<temporary QR image URL>)\`) so Codex Desktop renders a scannable image. The temporary QR image URL and pairing URL must be shown as clickable links; then tell the user to scan the 微信扫码二维码 with WeChat. Do not invent or alter either URL. If the command fails, show its exact safe error and do not claim that a QR code was generated.

If the user supplies a known persisted Codex thread ID, append \`--session <thread-id>\` to resume that exact thread. Do not claim that the command attached the current desktop conversation when no thread ID was supplied: Codex does not expose a documented current-thread substitution to this local skill.
`;
}

function help() {
  return `AgentBridge phone launcher

Usage:
  agentbridge phone [--agent claude|codex|echo] [--session ID] [--cwd PATH] [--title TEXT]
  agentbridge setup <codex|claude> [--user|--project] [--cwd PATH]
  agentbridge install-claude-skill [--user|--project] [--cwd PATH]
  agentbridge install-codex-skill [--user|--project] [--cwd PATH]

Examples:
  agentbridge phone --agent codex
  agentbridge phone --agent claude --session <claude-session-id>
  agentbridge setup codex
  agentbridge install-claude-skill --user`;
}

async function bridgeHealth(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) });
    const body = response.ok ? await response.json() : null;
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

async function bridgeIsReady(origin) {
  return (await bridgeHealth(origin)) !== null;
}

/** Whether a host:port is only reachable from the same network. */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Tailscale and ZeroTier hand out addresses from these ranges, which are
  // reachable from the phone only when it is on the same overlay.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

export function describeOrigin(origin) {
  try {
    const url = new URL(origin);
    return isPrivateHost(url.hostname) ? "private" : "public";
  } catch {
    return "private";
  }
}

/**
 * Where the tunnel state and the access key live.
 *
 * Deliberately the same directory the DSH plugin uses: if that plugin already
 * brought a tunnel up to the same port, the CLI reuses it instead of opening a
 * second one, and both sides read the same access key.
 */
function bridgeDataDir() {
  return path.resolve(process.env.AGENTBRIDGE_DATA_DIR ?? path.join(os.homedir(), ".agentbridge"));
}

/**
 * The address the QR code should carry, if this run is going to have one.
 *
 * The path itself is chosen by `src/remote.js`, which the DSH plugin shares — so
 * "which network am I on" has one answer in both entry points. Returns null when
 * the machine should stay on the LAN: the user opted out, the bridge is already
 * running under someone else's address, or no path could be brought up. Every one
 * of those is a normal outcome — same-Wi-Fi pairing still works — so the reason is
 * logged instead of thrown.
 */
export async function resolvePublicOrigin({ health, log = () => {}, env = process.env, dataDir = bridgeDataDir(), timeoutMs = 40_000 } = {}) {
  // An already-running bridge owns its address; asking it to move would mean
  // restarting a service the user may be using right now.
  if (health && !env.AGENTBRIDGE_PUBLIC_ORIGIN && !env.AGENTBRIDGE_TUNNEL_URL && parseMode(env) !== "lan") {
    const advertised = String(health.advertisedOrigin ?? "");
    if (describeOrigin(advertised) === "public") return { origin: advertised, accessKey: null, provider: "already-running", label: "已运行的桥", how: "already running" };
    log(`AgentBridge 已经在以局域网地址运行（${advertised || "unknown"}），本次二维码沿用这个地址。想换公网地址：先停掉它再重跑。`);
    return null;
  }

  const decided = await resolveRemote({ env, dataDir, log, port: String(env.AGENTBRIDGE_PORT ?? "8787") });
  if (!decided) return null;
  return { ...decided, how: decided.detail ?? decided.provider };
}

async function startBridge(origin, env = {}) {
  const child = spawn(process.execPath, [path.join(bridgeRoot, "src", "server.js")], {
    cwd: bridgeRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await bridgeIsReady(origin)) return true;
  }
  return false;
}

async function ensureBridge(origin, autoStart, log = () => {}) {
  const health = await bridgeHealth(origin);
  if (health) return health;
  if (!autoStart) throw new Error(`Bridge is not running at ${origin}`);

  // The path has to be chosen before the bridge starts, because the address is
  // baked into the pairing URL at startup — the exact opposite of the DSH plugin,
  // which keeps a local bridge up and restarts it once the address changes.
  const remote = await resolvePublicOrigin({ log });
  const env = remote
    ? {
      AGENTBRIDGE_PUBLIC_ORIGIN: remote.origin,
      AGENTBRIDGE_REMOTE_PROVIDER: remote.provider ?? "remote",
      ...(remote.accessKey ? { AGENTBRIDGE_ACCESS_KEY: remote.accessKey } : {}),
    }
    : {};
  if (await startBridge(origin, env)) {
    if (remote) log(`公网地址就绪：${remote.origin}（${remote.how}）`);
    return bridgeHealth(origin);
  }
  if (Object.keys(env).length) {
    log("带公网地址的桥没起来，退回只用这台电脑所在 Wi-Fi。");
    if (await startBridge(origin)) return bridgeHealth(origin);
  }
  throw new Error(`Could not start Bridge at ${origin}`);
}

async function requestPhone(options) {
  const port = process.env.AGENTBRIDGE_PORT ?? "8787";
  const origin = (process.env.AGENTBRIDGE_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const log = (message) => console.error(`[agentbridge] ${message}`);
  const health = await ensureBridge(origin, !options["no-start"], log);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const adapterId = options.agent ?? "claude";
  const response = await fetch(`${origin}/api/local/phone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd,
      adapterId,
      providerSessionId: options.session || undefined,
      title: options.title || `${path.basename(cwd)} · ${adapterId}`,
      commandId: randomUUID(),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Phone pairing failed (${response.status})`);

  if (options.json) {
    console.log(JSON.stringify(result));
    return result;
  }
  const qr = await QRCode.toString(result.pairing.url, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  // Naming the path matters: "it worked yesterday" usually means a different
  // provider won this time, or none did. The bridge reports which one it was
  // started with, so this stays right even when the tunnel is reused.
  const providerLabel = health?.remoteProvider ?? null;
  const network = describeOrigin(result.pairing.url) === "public"
    ? `公网地址，手机用流量也能打开${providerLabel ? `（${providerLabel}）` : ""}`
    : "局域网地址，手机需与电脑连同一个 Wi-Fi";
  console.log(`\nAgentBridge 已绑定当前对话`);
  console.log(`Agent: ${adapterId}`);
  console.log(`项目: ${cwd}`);
  console.log(`会话: ${result.session.providerSessionId ?? result.session.id}`);
  console.log(`网络: ${network}`);
  console.log(`有效期: ${new Date(result.pairing.expiresAt).toLocaleTimeString()}（一次性）\n`);
  console.log(qr);
  if (result.qrImageUrl) {
    console.log(`临时二维码图片地址（仅本机；扫码、配对成功或到期后失效）: ${result.qrImageUrl}`);
    console.log(`二维码图片 Markdown: ![微信扫码二维码](${result.qrImageUrl})`);
  }
  console.log(`微信扫码地址: ${result.pairing.url}`);
  console.log(`电脑端会话: ${origin}/?session=${encodeURIComponent(result.session.id)}`);
  // Consent-based and once, at the very end: no network call, no token, nothing
  // the user did not ask for. Star counts are how the plugin market ranks entries,
  // so asking is fair — clicking on their behalf would not be.
  console.log("觉得有用？给项目点个星：https://github.com/chenacc1/agentbridge\n");
  return result;
}

async function installClaudeSkill(options) {
  if (options.user && options.project) throw new Error("Choose only one of --user or --project");
  const projectCwd = path.resolve(options.cwd ?? process.cwd());
  const root = options.project
    ? path.join(projectCwd, ".claude", "skills")
    : path.join(os.homedir(), ".claude", "skills");
  const target = path.join(root, "phone", "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderClaudePhoneSkill(), { encoding: "utf8", flag: "w" });
  console.log(`Claude Code /phone 已安装到: ${target}`);
  console.log("重新打开 Claude Code 后，输入 /phone 即可生成当前对话的微信二维码。");
  return target;
}

async function installCodexSkill(options) {
  if (options.user && options.project) throw new Error("Choose only one of --user or --project");
  const projectCwd = path.resolve(options.cwd ?? process.cwd());
  const root = options.project
    ? path.join(projectCwd, ".agents", "skills")
    : path.join(os.homedir(), ".agents", "skills");
  const target = path.join(root, "phone", "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderCodexPhoneSkill(), { encoding: "utf8", flag: "w" });
  console.log(`Codex /phone 已安装到: ${target}`);
  console.log("重新打开 Codex 桌面项目后，在斜杠命令列表选择 /phone。未提供 thread ID 时，它会创建新的项目会话并清楚标注。");
  return target;
}

async function setup(options) {
  if (options.target === "codex") return installCodexSkill(options);
  if (options.target === "claude") return installClaudeSkill(options);
  throw new Error("Setup target must be one of: codex, claude");
}

export async function main(inputArgs) {
  const { command, options } = parseCliArguments([...inputArgs]);
  if (command === "help" || options.help) return console.log(help());
  if (command === "phone" || command === "qr") return requestPhone(options);
  if (command === "setup") return setup(options);
  if (command === "install-claude-skill") return installClaudeSkill(options);
  if (command === "install-codex-skill") return installCodexSkill(options);
  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}
