import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createBridge } from "../src/server.js";
import { AdapterRegistry } from "../src/adapter-registry.js";

// Notifications are the only part of this product that reaches the user when the
// page is closed, so they are verified end to end against a real HTTP receiver:
// the bridge has to actually put a body on the wire, exactly once per signal.

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function originOf(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

const received = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      received.push({ headers: req.headers, body: JSON.parse(body) });
    } catch {
      received.push({ headers: req.headers, body: body });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await listen(receiver);
const receiverUrl = `${originOf(receiver)}/hook`;

const problems = [];
const results = [];

async function waitFor(count, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function fixtureRegistry() {
  const registry = new AdapterRegistry();
  const state = { emit: null, approvals: [] };
  registry.register({
    id: "notify-fixture",
    label: "Notify Fixture",
    capabilities: { create: true, attach: false, resume: false, approve: true, answer: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) {
      state.emit = context.emit;
      return { providerSessionId: "notify-fixture-session" };
    },
    async send() {},
    async resolveApproval(_handle, approvalId, decision) {
      state.approvals.push({ approvalId, decision });
      return true;
    },
    async resolveInput() { return true; },
  });
  return { registry, state };
}

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-e2e-"));
const { registry, state } = fixtureRegistry();
const bridge = await createBridge({
  config: {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "https://example.trycloudflare.com",
    accessKey: "notify-key",
    secureCookies: false,
    dataDir: directory,
    projects: new Map([["demo", directory]]),
    pairingTtlMs: 10_000,
    sessionTtlMs: 60_000,
    machineName: "Notify verification",
    notifyWebhook: receiverUrl,
    notifyFormat: "json",
    notifyLink: true,
  },
  registry,
});
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = originOf(bridge.server);
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = login.headers.get("set-cookie").split(";", 1)[0];

const cleanup = async () => {
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await new Promise((resolve) => receiver.close(resolve));
  await rm(directory, { recursive: true, force: true });
};

try {
  // 1. the bridge reports whether notifications are configured
  const state0 = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
  if (!state0.notifications?.enabled) problems.push("state does not report notifications as enabled");
  if (state0.notifications?.format !== "json") problems.push(`state reports format ${state0.notifications?.format}`);
  results.push({ step: "state", notifications: state0.notifications });

  // 2. a real approval from an agent produces exactly one webhook call
  const created = await (await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ adapterId: "notify-fixture", projectAlias: "demo", title: "通知端到端", commandId: "notify-e2e-1" }),
  })).json();
  await new Promise((resolve) => setTimeout(resolve, 30));
  received.length = 0;

  await state.emit("approval.requested", {
    approvalId: "approval-1",
    adapter: "notify-fixture",
    method: "shell",
    request: { toolName: "shell", reason: "需要写入 src/server.js" },
  });
  if (!(await waitFor(1))) problems.push("the approval notification never reached the webhook");
  const first = received[0];
  if (first) {
    if (first.body.kind !== "approval.requested") problems.push(`unexpected kind ${first.body.kind}`);
    if (first.body.sessionId !== created.session.id) problems.push(`unexpected sessionId ${first.body.sessionId}`);
    if (!String(first.body.text).includes("shell")) problems.push(`the body does not name the tool: ${first.body.text}`);
    if (!first.body.url?.includes("key=notify-key")) problems.push(`the opt-in link is missing the access key: ${first.body.url}`);
    results.push({ step: "approval", body: { kind: first.body.kind, title: first.body.title } });
  }

  // 3. the same signal twice does not spam the chat
  await state.emit("approval.requested", {
    approvalId: "approval-2",
    adapter: "notify-fixture",
    method: "shell",
    request: { toolName: "shell" },
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (received.length !== 1) problems.push(`a repeated approval produced ${received.length} notifications instead of 1`);
  results.push({ step: "rate-limit", deliveries: received.length });

  // 4. a finished turn notifies with the tail of the reply
  await state.emit("message.completed", { role: "assistant", text: "改完了三个文件：server.js、app.js、styles.css" });
  await state.emit("turn.completed", {});
  if (!(await waitFor(2))) problems.push("the turn-finished notification never reached the webhook");
  const second = received[1];
  if (second && !String(second.body.text).includes("改完了三个文件")) problems.push(`the finished-turn preview is missing: ${second.body.text}`);
  results.push({ step: "turn.completed", body: second ? { title: second.body.title, text: second.body.text } : null });

  // 5. ordinary traffic stays out of the chat
  await state.emit("message.completed", { role: "user", text: "继续" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (received.length !== 2) problems.push(`ordinary messages produced notifications (${received.length} deliveries)`);

  // 6. the loopback test button really sends
  const test = await fetch(`${origin}/api/local/notify-test`, { method: "POST", headers: { "content-type": "application/json", origin, cookie } });
  if (!(await waitFor(3))) problems.push("the notification test endpoint did not deliver anything");
  const testBody = await test.json();
  if (test.status !== 200 || testBody.sent !== true) problems.push(`test endpoint answered ${test.status} ${JSON.stringify(testBody)}`);
  if (received[2]?.body?.kind !== "notify.test") problems.push(`test endpoint delivered ${received[2]?.body?.kind}`);
  results.push({ step: "notify-test", status: test.status, body: testBody });

  // 7. without a webhook the feature is inert and says so
  const offDirectory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-notify-off-"));
  const offline = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: offDirectory,
      projects: new Map([["demo", offDirectory]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "Notify off",
    },
  });
  await new Promise((resolve) => offline.server.listen(0, "127.0.0.1", resolve));
  const offOrigin = originOf(offline.server);
  const offState = await (await fetch(`${offOrigin}/api/state`, {
    headers: { cookie: (await fetch(`${offOrigin}/api/local-session`, { method: "POST", headers: { origin: offOrigin } })).headers.get("set-cookie").split(";", 1)[0] },
  })).json();
  if (offState.notifications?.enabled !== false) problems.push("an unset webhook still reports notifications as enabled");
  const offTest = await fetch(`${offOrigin}/api/local/notify-test`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: offOrigin,
      cookie: (await fetch(`${offOrigin}/api/local-session`, { method: "POST", headers: { origin: offOrigin } })).headers.get("set-cookie").split(";", 1)[0],
    },
  });
  if (offTest.status !== 409) problems.push(`notify-test answered ${offTest.status} with notifications disabled`);
  offline.server.closeAllConnections();
  await new Promise((resolve) => offline.server.close(resolve));
  await rm(offDirectory, { recursive: true, force: true });
  results.push({ step: "disabled", enabled: offState.notifications?.enabled, testStatus: offTest.status });

  // 7b. The phone's mute switch: it must silence the bridge, persist the choice, and
  // leave the configuration intact (a muted bridge is still a configured bridge).
  const beforeMute = received.length;
  const mute = await fetch(`${origin}/api/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ muted: true }),
  });
  const muteBody = await mute.json();
  if (mute.status !== 200 || muteBody.notifications?.muted !== true) problems.push(`muting answered ${mute.status} ${JSON.stringify(muteBody)}`);
  const mutedTest = await fetch(`${origin}/api/local/notify-test`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
  });
  const mutedTestBody = await mutedTest.json();
  if (mutedTestBody.sent !== false || mutedTestBody.reason !== "muted") problems.push(`a muted bridge still sent: ${JSON.stringify(mutedTestBody)}`);
  if (mutedTest.status !== 409) problems.push(`a muted test answered ${mutedTest.status}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (received.length !== beforeMute) problems.push("a muted bridge still reached the webhook");

  const mutedState = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
  if (mutedState.notifications?.muted !== true) problems.push(`state does not report the mute: ${JSON.stringify(mutedState.notifications)}`);
  const stored = JSON.parse(await readFile(path.join(directory, "notify.json"), "utf8"));
  if (stored.muted !== true) problems.push(`the mute was not written to notify.json: ${JSON.stringify(stored)}`);

  const unmute = await fetch(`${origin}/api/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ muted: false }),
  });
  const unmuteBody = await unmute.json();
  if (unmuteBody.notifications?.muted !== false) problems.push(`unmuting answered ${JSON.stringify(unmuteBody)}`);
  const afterUnmute = await fetch(`${origin}/api/local/notify-test`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
  });
  if ((await afterUnmute.json()).sent !== true) problems.push("the bridge stayed silent after unmuting");
  results.push({ step: "mute", muteBody, mutedTestBody, stored, unmuted: true });

  // 8. PushPlus: the documented body, and a 200-with-error-code that must NOT be
  // reported as sent (that is how PushPlus signals a bad token).
  const pushDirectory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-pushplus-"));
  const pushReceipts = [];
  const pushReceiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      pushReceipts.push(body);
      // First call "succeeds", every later call answers an error inside a 200.
      const failing = pushReceipts.length > 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(failing ? { code: 913, msg: "token 无效" } : { code: 200, msg: "请求成功" }));
    });
  });
  await listen(pushReceiver);
  const push = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: pushDirectory,
      projects: new Map([["demo", pushDirectory]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "PushPlus verification",
      notifyWebhook: `${originOf(pushReceiver)}/send`,
      notifyFormat: "pushplus",
      notifyToken: "pp-token-123",
    },
  });
  await new Promise((resolve) => push.server.listen(0, "127.0.0.1", resolve));
  const pushOrigin = originOf(push.server);
  const pushCookie = (await fetch(`${pushOrigin}/api/local-session`, { method: "POST", headers: { origin: pushOrigin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  const pushState = await (await fetch(`${pushOrigin}/api/state`, { headers: { cookie: pushCookie } })).json();
  if (pushState.notifications?.format !== "pushplus") problems.push(`state reports format ${pushState.notifications?.format}`);

  const firstTest = await (await fetch(`${pushOrigin}/api/local/notify-test`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: pushOrigin, cookie: pushCookie },
  })).json();
  if (firstTest.sent !== true) problems.push(`PushPlus test did not report success: ${JSON.stringify(firstTest)}`);
  const payload = pushReceipts[0];
  if (payload?.token !== "pp-token-123") problems.push(`the token is missing from the body: ${JSON.stringify(payload)}`);
  if (!payload?.title || !payload?.content) problems.push(`the message lacks a title or content: ${JSON.stringify(payload)}`);
  if (payload?.template !== "txt") problems.push(`unexpected template ${payload?.template}`);

  const secondTest = await fetch(`${pushOrigin}/api/local/notify-test`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: pushOrigin, cookie: pushCookie },
  });
  const secondBody = await secondTest.json();
  if (secondBody.sent !== false) problems.push(`a 200 with code 913 was reported as sent: ${JSON.stringify(secondBody)}`);
  if (!String(secondBody.reason).includes("913")) problems.push(`the provider error is not surfaced: ${JSON.stringify(secondBody)}`);
  results.push({ step: "pushplus", payload: { token: payload?.token, template: payload?.template }, firstTest, secondBody, secondStatus: secondTest.status });

  push.server.closeAllConnections();
  await new Promise((resolve) => push.server.close(resolve));
  await new Promise((resolve) => pushReceiver.close(resolve));
  await rm(pushDirectory, { recursive: true, force: true });

  for (const line of results) console.log(JSON.stringify(line));
  if (problems.length) {
    console.error("\nNotification verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("PASS  approvals and finished turns reach a real webhook exactly once, and an unconfigured bridge stays silent");
  }
} finally {
  await cleanup();
}
