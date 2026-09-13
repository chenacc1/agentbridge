import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, parseCliArguments, renderClaudePhoneSkill, renderCodexPhoneSkill } from "../src/cli.js";

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
