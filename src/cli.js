import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

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

async function bridgeIsReady(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) });
    const body = response.ok ? await response.json() : null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function ensureBridge(origin, autoStart) {
  if (await bridgeIsReady(origin)) return;
  if (!autoStart) throw new Error(`Bridge is not running at ${origin}`);
  const child = spawn(process.execPath, [path.join(bridgeRoot, "src", "server.js")], {
    cwd: bridgeRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await bridgeIsReady(origin)) return;
  }
  throw new Error(`Could not start Bridge at ${origin}`);
}

async function requestPhone(options) {
  const port = process.env.AGENTBRIDGE_PORT ?? "8787";
  const origin = (process.env.AGENTBRIDGE_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  await ensureBridge(origin, !options["no-start"]);
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
  console.log(`\nAgentBridge 已绑定当前对话`);
  console.log(`Agent: ${adapterId}`);
  console.log(`项目: ${cwd}`);
  console.log(`会话: ${result.session.providerSessionId ?? result.session.id}`);
  console.log(`有效期: ${new Date(result.pairing.expiresAt).toLocaleTimeString()}（一次性）\n`);
  console.log(qr);
  if (result.qrImageUrl) {
    console.log(`临时二维码图片地址（仅本机；扫码、配对成功或到期后失效）: ${result.qrImageUrl}`);
    console.log(`二维码图片 Markdown: ![微信扫码二维码](${result.qrImageUrl})`);
  }
  console.log(`微信扫码地址: ${result.pairing.url}`);
  console.log(`电脑端会话: ${origin}/?session=${encodeURIComponent(result.session.id)}\n`);
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
