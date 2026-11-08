import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, parseCliArguments, renderClaudePhoneSkill, renderCodexPhoneSkill, describeOrigin, resolvePublicOrigin } from "../src/cli.js";

test("phone CLI parses an attached Claude conversation", () => {
  const parsed = parseCliArguments(["phone", "--agent", "claude", "--session", "session-123", "--cwd", "D:\\work"]);
  assert.deepEqual(parsed, {
    command: "phone",
    options: { agent: "claude", session: "session-123", cwd: "D:\\work" },
  });
});

test("setup parses a Codex target and installs a project-scoped phone skill", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "agentbridge-setup-codex-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  assert.deepEqual(parseCliArguments(["setup", "codex", "--project", "--cwd", projectDir]), {
    command: "setup",
    options: { target: "codex", project: true, cwd: projectDir },
  });

  await main(["setup", "codex", "--project", "--cwd", projectDir]);
  const skill = await readFile(path.join(projectDir, ".agents", "skills", "phone", "SKILL.md"), "utf8");
  assert.match(skill, /Generate a one-time WeChat QR code for a Codex project conversation/);
});

test("setup rejects an unsupported target", async () => {
  await assert.rejects(main(["setup", "unknown"]), /Setup target must be one of: codex, claude/);
});

test("Codex phone skill uses the current project and never fabricates a desktop thread id", () => {
  const skill = renderCodexPhoneSkill("D:\\Agent Bridge\\bin\\agentbridge.js");
  assert.match(skill, /name: phone/);
  assert.match(skill, /phone --agent codex --cwd \./);
  assert.match(skill, /must immediately execute.*terminal/i);
  assert.match(skill, /pairing URL.*must be shown/i);
  assert.match(skill, /微信扫码二维码/i);
  assert.match(skill, /temporary QR image/i);
  assert.match(skill, /--session <thread-id>/);
  assert.match(skill, /do not claim.*current desktop conversation/i);
  assert.doesNotMatch(skill, /CODEX_THREAD_ID/);
});

test("Claude phone skill binds the official current session substitution", () => {
  const skill = renderClaudePhoneSkill("D:\\Agent Bridge\\bin\\agentbridge.js");
  assert.match(skill, /\$\{CLAUDE_SESSION_ID\}/);
  assert.match(skill, /phone --agent claude --session/);
  assert.match(skill, /node "D:\/Agent Bridge\/bin\/agentbridge\.js"/);
  assert.match(
    skill,
    /allowed-tools: Bash\(node "D:\/Agent Bridge\/bin\/agentbridge\.js" phone --agent claude --session \* --cwd \.\)/,
  );
  assert.doesNotMatch(skill, /\$ARGUMENTS/);
  assert.doesNotMatch(skill, /transcript\.jsonl/);
});

test("only addresses the phone cannot route to count as private", () => {
  for (const origin of [
    "http://127.0.0.1:8787/pair",
    "http://192.168.0.2:8787",
    "http://10.1.2.3:8787",
    "http://172.20.0.5:8787",
    "http://100.83.253.5:8787",
    "http://desktop-mq3a4tb.local:8787",
  ]) assert.equal(describeOrigin(origin), "private", origin);

  for (const origin of [
    "https://leonard-wave-fell-chubby.trycloudflare.com/pair?code=x",
    "https://bridge.example.com",
    "http://203.0.113.9:8787",
  ]) assert.equal(describeOrigin(origin), "public", origin);
});

test("an explicit public origin wins and needs no tunnel", async () => {
  const decided = await resolvePublicOrigin({ env: { AGENTBRIDGE_PUBLIC_ORIGIN: "https://bridge.example.com/" } });
  assert.equal(decided.provider, "explicit");
  assert.equal(decided.origin, "https://bridge.example.com");
  assert.equal(decided.accessKey, null);
  assert.equal(decided.isPublic, true);
});

test("a bridge that already publishes a public address is left alone", async () => {
  const decided = await resolvePublicOrigin({
    env: {},
    health: { ok: true, advertisedOrigin: "https://already.trycloudflare.com" },
  });
  assert.equal(decided.origin, "https://already.trycloudflare.com");
  assert.equal(decided.how, "already running");
});

test("a bridge stuck on a LAN address is reported, not silently restarted", async () => {
  const messages = [];
  const decided = await resolvePublicOrigin({
    env: {},
    health: { ok: true, advertisedOrigin: "http://192.168.0.2:8787" },
    log: (message) => messages.push(message),
  });
  assert.equal(decided, null);
  assert.ok(messages.some((message) => message.includes("192.168.0.2")), messages.join(" | "));
});

test("opting out of the tunnel keeps the QR code on this Wi-Fi", async () => {
  const messages = [];
  const decided = await resolvePublicOrigin({
    env: { AGENTBRIDGE_NO_TUNNEL: "1" },
    log: (message) => messages.push(message),
  });
  assert.equal(decided, null);
  assert.ok(messages.some((message) => message.includes("AGENTBRIDGE_NO_TUNNEL")));
});
