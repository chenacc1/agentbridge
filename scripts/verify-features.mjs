import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";
import { AdapterRegistry } from "../src/adapter-registry.js";

// Three P2 features that only make sense on a phone, verified in a real mobile
// viewport: a message typed while the agent is busy becomes a visible queue entry,
// the queue can be taken back, speech input writes into the composer when the
// engine exists, and long tool output collapses instead of flooding the transcript.

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9340);
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

class Cdp {
  #ws; #id = 0; #pending = new Map(); #sessionId = null;

  static async attach(port) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const client = new Cdp();
        await client.#connect(info.webSocketDebuggerUrl);
        return client;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("the browser DevTools endpoint never became available");
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener("open", resolve);
      this.#ws.addEventListener("error", reject);
      this.#ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      });
    });
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (useSession && this.#sessionId) payload.sessionId = this.#sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async openPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, false);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, false);
    this.#sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    return result.result.value;
  }

  close() { this.#ws?.close(); }
}

const browserPath = await findBrowser();
if (!browserPath) throw new Error("Chrome or Edge was not found");

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-features-"));
const projectDirectory = path.join(directory, "功能验证");
await mkdir(projectDirectory);

const registry = new AdapterRegistry();
const state = { emit: null, sent: [], finish: null };
registry.register({
  id: "feature-fixture",
  label: "Feature Fixture",
  capabilities: { create: true },
  detect: async () => ({ available: true, supported: true }),
  async start(context) {
    state.emit = context.emit;
    return { providerSessionId: "feature-fixture-session" };
  },
  async send(_handle, payload) {
    state.sent.push(payload);
    state.finish = () => payload.emit("turn.completed", { status: "end_turn" });
  },
});

const bridge = await createBridge({
  config: {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: path.join(directory, "data"),
    projects: new Map([["feature", projectDirectory]]),
    pairingTtlMs: 60_000,
    sessionTtlMs: 600_000,
    machineName: "Feature verification",
  },
  registry,
});
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const device = { id: "feature-device", deviceName: "Verification" };
const session = await bridge.sessions.create({
  adapterId: "feature-fixture",
  projectAlias: "feature",
  title: "P2 功能验证",
  commandId: "feature-create-1",
  device,
});
// A long tool call, so the transcript has something to collapse.
await bridge.sessions.send({
  sessionId: session.id,
  text: "跑一次很长的命令",
  commandId: "feature-send-1",
  device,
});
await new Promise((resolve) => setTimeout(resolve, 60));
await state.emit("tool.started", {
  command: `npm test -- --reporter=spec ${"a".repeat(400)}`,
  type: "shell",
}, {});
await new Promise((resolve) => setTimeout(resolve, 60));

const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const sessionToken = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));

const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-feature-cdp-"));
const browser = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const problems = [];
let cdp;
try {
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: sessionToken, domain: "127.0.0.1", path: "/" });
  // A stand-in for the Web Speech engine: the button has to appear, start, and write
  // what the engine produced into the composer.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      class FakeRecognition {
        constructor() { this.lang = ""; this.interimResults = false; this.continuous = false; window.__recognition = this; }
        start() { window.__recognitionStarted = true; }
        stop() { if (this.onend) this.onend(); }
        emit(text) { if (this.onresult) this.onresult({ resultIndex: 0, results: [[{ transcript: text }]] }); }
      }
      window.SpeechRecognition = FakeRecognition;
    })();`,
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${origin}/` });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#composer'))")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cdp.evaluate("document.querySelector('#desktop-pairing')?.setAttribute('hidden',''); document.querySelector('#return-entry')?.setAttribute('hidden','')");
  await cdp.evaluate(`(() => {
    const agent = document.querySelector('#drawer-tree .drawer-agent[data-agent="feature-fixture"]');
    if (agent && agent.getAttribute('aria-expanded') !== 'true') agent.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await cdp.evaluate(`document.querySelector('#drawer-tree [data-session="${session.id}"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  // ---- 1. 工具输出可折叠、命令可复制 ----
  const tool = await cdp.evaluate(`(() => {
    const details = document.querySelector('.event-entry.tool details.tool-output');
    const copy = document.querySelector('.event-entry.tool .tool-copy');
    return {
      collapsed: details ? !details.open : false,
      summary: details?.querySelector('summary')?.textContent.trim() ?? '',
      copyLabel: copy?.textContent.trim() ?? '',
      copyValue: copy?.dataset.copyTool?.slice(0, 24) ?? '',
    };
  })()`);
  if (!tool.summary.includes("展开完整输出")) problems.push(`long tool output is not collapsible: ${JSON.stringify(tool)}`);
  if (!tool.collapsed) problems.push("the tool output started expanded");
  if (tool.copyLabel !== "复制命令") problems.push(`the copy affordance is missing: ${JSON.stringify(tool.copyLabel)}`);
  console.log(JSON.stringify({ step: "tool-output", ...tool }));

  // ---- 2. 语音输入 ----
  const voice = await cdp.evaluate(`(async () => {
    const button = document.querySelector('#voice-button');
    if (button.hidden) return { hidden: true };
    button.click();
    const started = Boolean(window.__recognitionStarted);
    window.__recognition.emit('把登录接口改成 JWT');
    return { hidden: false, started, value: document.querySelector('#message-input').value, pressed: button.getAttribute('aria-pressed') };
  })()`);
  if (voice.hidden) problems.push("the voice button is hidden even though a speech engine exists");
  if (!voice.started) problems.push("clicking the voice button did not start recognition");
  if (!String(voice.value).includes("JWT")) problems.push(`speech did not reach the composer: ${JSON.stringify(voice.value)}`);
  if (voice.pressed !== "true") problems.push("the voice button does not show it is listening");
  console.log(JSON.stringify({ step: "voice", ...voice }));

  // ---- 3. 运行中排队 + 撤回 ----
  // The phone has to own the input lease before it can type into this conversation.
  await cdp.evaluate(`(async () => {
    await fetch('/api/sessions/${session.id}/control', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'feature-control-1', force: true }),
    });
  })()`);
  await cdp.evaluate("document.querySelector('#message-input').value = ''");
  // The fixture session is already running a turn from the seeding step.
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '顺便把超时也调大';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
  })()`);
  let queueState = null;
  const queueDeadline = Date.now() + 10_000;
  while (Date.now() < queueDeadline) {
    queueState = await cdp.evaluate(`(() => {
      const box = document.querySelector('#composer-queue');
      const item = box?.querySelector('.queue-item');
      return {
        hidden: box?.hidden ?? true,
        text: item?.textContent.trim() ?? '',
        id: item?.dataset.queueId ?? '',
        inputCleared: document.querySelector('#message-input').value === '',
      };
    })()`);
    if (!queueState.hidden && queueState.text) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (queueState.hidden || !queueState.text.includes("顺便把超时也调大")) {
    problems.push(`the queued message is not visible: ${JSON.stringify(queueState)}`);
  }
  if (!queueState.inputCleared) problems.push("the composer kept the text after queueing it");
  console.log(JSON.stringify({ step: "queue", ...queueState }));

  await cdp.evaluate("document.querySelector('#composer-queue .queue-item button')?.click()");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterCancel = await cdp.evaluate(`(() => ({
    hidden: document.querySelector('#composer-queue').hidden,
    items: document.querySelectorAll('#composer-queue .queue-item').length,
  }))()`);
  if (!afterCancel.hidden && afterCancel.items > 0) problems.push(`cancelling left ${afterCancel.items} queue entries`);
  console.log(JSON.stringify({ step: "queue-cancel", ...afterCancel }));

  // ---- 4. 回合结束后队列里的消息才会发出 ----
  state.finish();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stillQueued = bridge.sessions.list().find((entry) => entry.id === session.id)?.queued ?? [];
  if (stillQueued.length) problems.push(`the queue did not drain: ${JSON.stringify(stillQueued)}`);

  // ---- 5. 输入框几何：发送键必须贴住内边缘，空输入框不该是个大空盒 ----
  // .composer 曾经还留着 "1fr 48px" 两列（老结构里发送键独占第二列），DOM 改成
  // 单行 flex 后第二列永远空着，发送键右侧多出 69px。这里钉死：只有一列、
  // 右侧只允许 padding+border 的 14px、空输入框高度不超过一行多一点。
  const COMPOSER_GEOMETRY = `(() => {
    const composer = document.querySelector('#composer');
    const row = document.querySelector('.composer-row');
    const send = document.querySelector('.send-button');
    const textarea = document.querySelector('#message-input');
    const rect = (element) => { const r = element.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
    const style = getComputedStyle(composer);
    return {
      columns: style.gridTemplateColumns,
      paddingRight: parseFloat(style.paddingRight),
      borderRight: parseFloat(style.borderRightWidth),
      composer: rect(composer), row: rect(row), send: rect(send), textarea: rect(textarea),
      emptyValue: textarea.value === '',
    };
  })()`;
  const composerReports = [];
  for (const viewport of [{ width: 390, height: 844, mobile: true }, { width: 1506, height: 700, mobile: false }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: viewport.mobile });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const geometry = await cdp.evaluate(COMPOSER_GEOMETRY);
    composerReports.push({ viewport: viewport.width, ...geometry });
    const tracks = geometry.columns.trim().split(/\s+/).filter(Boolean);
    if (tracks.length !== 1) problems.push(`${viewport.width}px: the composer still declares ${tracks.length} grid columns (${geometry.columns}), so one is empty`);
    const slack = geometry.composer.right - geometry.send.right;
    const allowed = geometry.paddingRight + geometry.borderRight + 1;
    if (slack > allowed) problems.push(`${viewport.width}px: the send button leaves ${slack}px of empty space (only ${allowed}px of padding+border is legitimate)`);
    if (Math.abs(geometry.row.right - geometry.send.right) > 1) problems.push(`${viewport.width}px: the composer row ends ${geometry.row.right - geometry.send.right}px past the send button`);
    if (geometry.send.height < 44) problems.push(`${viewport.width}px: the send button is only ${geometry.send.height}px tall`);
    if (geometry.emptyValue && geometry.composer.height > 90) problems.push(`${viewport.width}px: an empty composer is ${geometry.composer.height}px tall, which reads as an empty box`);
  }
  console.log(JSON.stringify({ step: "composer-geometry", composerReports }));

  if (problems.length) {
    console.error("\nFeature verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("PASS  queueing, voice input and collapsible tool output all work on a phone viewport");
  }
} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const target of [directory, profile]) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best effort
    }
  }
}