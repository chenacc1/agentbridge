import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";
import { Notifier, buildWebhookRequest, describeNotification, providerProblem } from "../src/notifier.js";
import { loadConfig, notificationLink, readNotifyConfig, writeNotifyConfig } from "../src/config.js";

function recorder() {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
  };
}

test("a disabled notifier sends nothing at all", async () => {
  const sink = recorder();
  const notifier = new Notifier({ webhookUrl: null, fetch: sink.fetch });

  assert.equal(notifier.enabled, false);
  assert.deepEqual(await notifier.send("turn.completed", {}, { sessionId: "s1" }), { sent: false, reason: "disabled" });
  assert.equal(sink.calls.length, 0);
});

test("each provider gets the body shape it actually understands", () => {
  const base = { webhookUrl: "https://example.test/hook", chatId: "42", title: "标题", text: "正文", payload: { kind: "turn.completed" } };

  const generic = buildWebhookRequest({ ...base, format: "json" });
  assert.equal(generic.body.text, "标题\n正文");
  assert.equal(generic.body.kind, "turn.completed");

  const wecom = buildWebhookRequest({ ...base, format: "wecom" });
  assert.equal(wecom.body.msgtype, "text");
  assert.equal(wecom.body.text.content, "标题\n正文");

  const telegram = buildWebhookRequest({ ...base, format: "telegram" });
  assert.equal(telegram.body.chat_id, "42");
  assert.equal(telegram.body.disable_web_page_preview, true);

  const serverchan = buildWebhookRequest({ ...base, format: "serverchan" });
  assert.deepEqual(serverchan.body, { title: "标题", desp: "正文" });
});

test("notification text names the agent, the conversation and what is blocking", () => {
  const approval = describeNotification("approval.requested", {
    request: { toolName: "shell", reason: "需要写入文件" },
  }, { sessionTitle: "修复登录", adapterLabel: "OpenAI Codex" });
  assert.match(approval.title, /需要批准：shell/);
  assert.match(approval.text, /修复登录/);
  assert.match(approval.text, /需要写入文件/);

  const question = describeNotification("input.requested", {
    questions: [{ question: "用 SQLite 还是 Postgres？" }, { question: "第二个问题" }],
  }, { sessionTitle: "选型" });
  assert.match(question.title, /等你回答（共 2 个问题）/);
  assert.match(question.text, /SQLite/);

  const completed = describeNotification("turn.completed", {}, { sessionTitle: "长任务", lastAssistantText: "改完了三个文件" });
  assert.match(completed.title, /回合结束：长任务/);
  assert.match(completed.text, /改完了三个文件/);

  const failed = describeNotification("turn.failed", { error: "boom" }, { sessionTitle: "长任务" });
  assert.match(failed.title, /回合失败/);
  assert.match(failed.text, /boom/);
});

test("the same event does not storm the chat, but a different event still gets through", async () => {
  const sink = recorder();
  let clock = 1_000;
  const notifier = new Notifier({ webhookUrl: "https://example.test/hook", fetch: sink.fetch, now: () => clock, minIntervalMs: 15_000 });

  assert.equal((await notifier.send("turn.completed", {}, { sessionId: "s1" })).sent, true);
  clock += 100;
  assert.deepEqual(await notifier.send("turn.completed", {}, { sessionId: "s1" }), { sent: false, reason: "rate-limited" });
  assert.equal(sink.calls.length, 1);

  // A different kind for the same session is a different signal.
  assert.equal((await notifier.send("turn.failed", {}, { sessionId: "s1" })).sent, true);
  // And so is the same kind for a different session.
  assert.equal((await notifier.send("turn.completed", {}, { sessionId: "s2" })).sent, true);
  assert.equal(sink.calls.length, 3);
});

test("a dead webhook never throws and never reports success", async () => {
  const notifier = new Notifier({
    webhookUrl: "https://example.test/hook",
    fetch: async () => { throw new Error("ECONNREFUSED"); },
    logger: { warn() {} },
  });
  assert.deepEqual(await notifier.send("turn.completed", {}, { sessionId: "s1" }), { sent: false, reason: "error" });

  const rejecting = new Notifier({
    webhookUrl: "https://example.test/hook",
    fetch: async () => ({ ok: false, status: 500 }),
    logger: { warn() {} },
  });
  assert.deepEqual(await rejecting.send("turn.completed", {}, { sessionId: "s1" }), { sent: false, reason: "http-500" });
});

test("the notification link stays keyless unless the operator opts in", () => {
  const config = { advertisedOrigin: "https://example.trycloudflare.com", accessKey: "secret-key", notifyLink: false };
  assert.equal(notificationLink(config), "https://example.trycloudflare.com");
  assert.equal(notificationLink({ ...config, notifyLink: true }), "https://example.trycloudflare.com/?key=secret-key");
  assert.equal(notificationLink({}), null);
});

async function managerWith(sink) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-"));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  let emitting = null;
  registry.register({
    id: "notify-fixture",
    label: "Notify Fixture",
    capabilities: { create: true, streaming: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) {
      emitting = context.emit;
      return { providerSessionId: "fixture-session" };
    },
    async send() {},
  });
  const notifier = new Notifier({ webhookUrl: "https://example.test/hook", fetch: sink.fetch, logger: { warn() {} } });
  const manager = new SessionManager({
    eventStore,
    registry,
    projects: new Map([["demo", directory]]),
    notifier,
  });
  return { directory, eventStore, manager, notifier, emit: (kind, payload) => emitting(kind, payload) };
}

test("an approval request notifies, while ordinary transcript traffic does not", async (t) => {
  const sink = recorder();
  const fixture = await managerWith(sink);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const session = await fixture.manager.create({
    adapterId: "notify-fixture",
    projectAlias: "demo",
    title: "通知验证",
    commandId: "notify-create-1",
    device: { id: "phone", deviceName: "Phone" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  sink.calls.length = 0;

  await fixture.emit("message.completed", { role: "assistant", text: "普通消息不该推送" });
  await fixture.emit("approval.requested", { approvalId: "a1", method: "shell", request: { toolName: "shell" } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sink.calls.length, 1, `expected exactly one notification, got ${JSON.stringify(sink.calls)}`);
  const body = sink.calls[0].body;
  assert.equal(body.kind, "approval.requested");
  assert.equal(body.sessionId, session.id);
  assert.equal(body.sessionTitle, "通知验证");
  assert.match(body.text, /shell/);
});

test("PushPlus gets the body its API documents, with the token in the body or the URL", () => {
  const base = { format: "pushplus", title: "需要批准：shell", text: "修复登录 · Agent 想执行 shell", payload: {} };

  const withToken = buildWebhookRequest({ ...base, webhookUrl: "https://www.pushplus.plus/send", token: "abc123" });
  assert.equal(withToken.url, "https://www.pushplus.plus/send");
  assert.deepEqual(withToken.body, {
    token: "abc123",
    title: "需要批准：shell",
    content: "需要批准：shell\n修复登录 · Agent 想执行 shell",
    template: "txt",
  });

  // PushPlus also accepts the token inside the URL, so a URL that already carries it
  // must not have a second one added to the body.
  const inUrl = buildWebhookRequest({ ...base, webhookUrl: "https://www.pushplus.plus/send/abc123", token: "abc123" });
  assert.equal(inUrl.body.token, undefined);
  assert.equal(inUrl.body.title, "需要批准：shell");
  const queryToken = buildWebhookRequest({ ...base, webhookUrl: "https://www.pushplus.plus/send?token=abc123", token: "abc123" });
  assert.equal(queryToken.body.token, undefined);
});

test("a provider that answers 200 with an error code is reported as not sent", async () => {
  const notifier = new Notifier({
    webhookUrl: "https://www.pushplus.plus/send",
    format: "pushplus",
    token: "abc123",
    logger: { warn() {} },
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 913, msg: "token 无效" }),
    }),
  });
  assert.deepEqual(await notifier.send("turn.completed", {}, { sessionId: "s1" }), { sent: false, reason: "provider-913:token 无效" });

  const healthy = new Notifier({
    webhookUrl: "https://www.pushplus.plus/send",
    format: "pushplus",
    token: "abc123",
    logger: { warn() {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: "请求成功" }) }),
  });
  assert.deepEqual(await healthy.send("turn.completed", {}, { sessionId: "s2" }), { sent: true });
});

test("each provider's own failure field is understood", () => {
  assert.equal(providerProblem("wecom", { errcode: 93000, errmsg: "invalid webhook url" }), "provider-93000:invalid webhook url");
  assert.equal(providerProblem("wecom", { errcode: 0 }), null);
  assert.equal(providerProblem("pushplus", { code: 200 }), null);
  assert.equal(providerProblem("pushplus", { code: 999, msg: "token 错误" }), "provider-999:token 错误");
  assert.equal(providerProblem("serverchan", { code: 40001, message: "bad sendkey" }), "provider-40001:bad sendkey");
  assert.equal(providerProblem("serverchan", { data: { errno: 1024, errmsg: "push limit" } }), "provider-1024:push limit");
  assert.equal(providerProblem("telegram", { ok: false, error_code: 400, description: "chat not found" }), "provider-400:chat not found");
  assert.equal(providerProblem("telegram", { ok: true }), null);
  // A generic endpoint's body is its own business.
  assert.equal(providerProblem("json", { code: 500 }), null);
  assert.equal(providerProblem("pushplus", null), null);
});
test("the ClawBot channel is carried in the PushPlus body", () => {
  const request = buildWebhookRequest({
    format: "pushplus",
    webhookUrl: "https://www.pushplus.plus/send",
    token: "abc123",
    channel: "clawbot",
    title: "需要批准：shell",
    text: "修复登录",
    payload: {},
  });
  assert.equal(request.body.channel, "clawbot");
  assert.equal(request.body.token, "abc123");
  assert.equal(request.body.template, "txt");

  // No channel configured means no channel field at all: PushPlus then uses the
  // account default, which is what a user without ClawBot expects.
  const plain = buildWebhookRequest({ format: "pushplus", webhookUrl: "https://www.pushplus.plus/send", token: "abc", title: "t", text: "x", payload: {} });
  assert.equal("channel" in plain.body, false);
});

test("notification settings can come from .agentbridge/notify.json, with env still winning", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "notify.json"), JSON.stringify({
    webhook: "https://www.pushplus.plus/send",
    format: "pushplus",
    token: "file-token",
    channel: "clawbot",
    link: true,
  }), "utf8");

  const fromFile = loadConfig({ AGENTBRIDGE_DATA_DIR: directory }, directory);
  assert.equal(fromFile.notifyFormat, "pushplus");
  assert.equal(fromFile.notifyToken, "file-token");
  assert.equal(fromFile.notifyChannel, "clawbot");
  assert.equal(fromFile.notifyLink, true);
  assert.equal(fromFile.notifyWebhook, "https://www.pushplus.plus/send");

  // An explicit environment variable still overrides the file, so `setx` keeps working.
  const overridden = loadConfig({
    AGENTBRIDGE_DATA_DIR: directory,
    AGENTBRIDGE_NOTIFY_TOKEN: "env-token",
    AGENTBRIDGE_NOTIFY_CHANNEL: "wechat",
  }, directory);
  assert.equal(overridden.notifyToken, "env-token");
  assert.equal(overridden.notifyChannel, "wechat");

  // A missing or broken file must not take the bridge down.
  const empty = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-none-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const noFile = loadConfig({ AGENTBRIDGE_DATA_DIR: empty }, empty);
  assert.equal(noFile.notifyWebhook, null);
  assert.equal(noFile.notifyFormat, "json");
});
test("muting silences the notifier without discarding its configuration", async () => {
  const calls = [];
  const notifier = new Notifier({
    webhookUrl: "https://www.pushplus.plus/send",
    format: "pushplus",
    token: "abc",
    channel: "clawbot",
    fetch: async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) }; },
  });

  assert.equal(notifier.muted, false);
  assert.equal((await notifier.send("turn.completed", {}, { sessionId: "s1" })).sent, true);
  assert.equal(calls.length, 1);

  notifier.setMuted(true);
  assert.equal(notifier.muted, true);
  assert.deepEqual(await notifier.send("turn.completed", {}, { sessionId: "s2" }), { sent: false, reason: "muted" });
  assert.equal(calls.length, 1, "a muted bridge must not call the provider at all");
  // The configuration is untouched: unmuting works immediately.
  assert.equal(notifier.enabled, true);
  assert.equal(notifier.channel, "clawbot");

  notifier.setMuted(false);
  assert.equal((await notifier.send("turn.completed", {}, { sessionId: "s3" })).sent, true);
  assert.equal(calls.length, 2);
});

test("the mute flag persists in notify.json and keeps the token", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-mute-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "notify.json"), JSON.stringify({
    webhook: "https://www.pushplus.plus/send",
    format: "pushplus",
    token: "keep-me",
    channel: "clawbot",
  }), "utf8");

  writeNotifyConfig(directory, { muted: true });
  const stored = readNotifyConfig(directory);
  assert.equal(stored.muted, true);
  assert.equal(stored.token, "keep-me", "the merge dropped the token");
  assert.equal(stored.channel, "clawbot");

  const config = loadConfig({ AGENTBRIDGE_DATA_DIR: directory }, directory);
  assert.equal(config.notifyMuted, true);

  writeNotifyConfig(directory, { muted: false });
  assert.equal(loadConfig({ AGENTBRIDGE_DATA_DIR: directory }, directory).notifyMuted, false);
});