// End-to-end check of the phone half of "the desktop agent asks a question".
//
// The adapter tests prove a question becomes a card, and the HTTP tests prove a card can
// be answered. Neither drives a browser, so nothing verified that the phone actually
// *renders* the card, that its options are clickable, or that what the user picks is what
// the desktop receives. That is the link the user asks about.
//
// Flow: fake DSH companion registers → posts a question-requested interaction → phone
// page must show the card → click options → 提交回答 → the companion's poll must carry
// exactly those answers in question order → confirming resolves the card. A second round
// checks 跳过 becomes cancel-question.
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9350);
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* next candidate */ }
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
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    return result.result.value;
  }

  close() { this.#ws?.close(); }
}

const browserPath = await findBrowser();
if (!browserPath) {
  console.error("No Chrome or Edge binary was found. Set CHROME_PATH to run this verification.");
  process.exit(2);
}

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-questions-"));
const config = {
  host: "127.0.0.1",
  port: 0,
  advertisedOrigin: "http://127.0.0.1:0",
  secureCookies: false,
  dataDir: directory,
  projects: new Map([["demo", directory]]),
  pairingTtlMs: 60_000,
  sessionTtlMs: 600_000,
  machineName: "Verify machine",
};
const bridge = await createBridge({ config });
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;

// A stand-in desktop companion: it registers, then the test decides when it "asks".
const registration = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "questions-session", cwd: directory, title: "问答链路", provider: "ds", model: "ds-chat" }),
})).json();
const { id: channelId, token } = registration.channel;
const sessionId = registration.session.id;

await fetch(`${origin}${registration.channel.eventsPath}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ events: [
    { event: { type: "turn/start", seq: 1, time: Date.now(), data: {} }, origin: "desktop" },
    { event: { type: "assistant/message", seq: 2, time: Date.now(), data: { message: { content: [{ type: "text", text: "我准备开始，先确认两件事。" }], source: { provider: "ds", model: "ds-chat" } } } }, origin: "desktop" },
  ] }),
});

const profile = await mkdtemp(path.join(directory, "cdp-"));
const chrome = spawn(browserPath, [
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
  const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
  const sessionToken = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));

  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: sessionToken, domain: "127.0.0.1", path: "/" });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${origin}/` });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#drawer-tree'))")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cdp.evaluate("document.querySelector('#desktop-pairing')?.setAttribute('hidden',''); document.querySelector('#return-entry')?.setAttribute('hidden','')");
  await cdp.evaluate(`(() => {
    const agent = document.querySelector('#drawer-tree .drawer-agent[data-agent="deepseek-harness-desktop"]');
    if (agent && agent.getAttribute('aria-expanded') !== 'true') agent.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await cdp.evaluate(`[...document.querySelectorAll('#drawer-tree [data-session]')].find((row) => row.dataset.session === ${JSON.stringify(sessionId)})?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await cdp.evaluate("document.querySelector('#drawer-close')?.click()");

  /** Post one question batch from the "desktop" and return its rpc id. */
  async function ask(rpcId, questions) {
    const response = await fetch(`${origin}${registration.channel.interactionsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ interactions: [{ kind: "question-requested", requestId: rpcId, questions }] }),
    });
    if (response.status !== 202) throw new Error(`the interaction was rejected: ${response.status}`);
  }

  async function waitForBrowser(expression, label, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await cdp.evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  // ---- Round 1: the phone must show the card, and the answers must travel back ----
  await ask("rpc-question-submit", [
    {
      id: "mode",
      header: "存储选择",
      question: "用哪个存储？",
      options: [{ label: "SQLite", description: "单文件，最省事" }, { label: "Postgres" }],
      multiSelect: false,
    },
    {
      id: "checks",
      header: "检查项",
      question: "要跑哪些检查？",
      options: [{ label: "lint" }, { label: "test" }, { label: "typecheck" }],
      multiSelect: true,
    },
  ]);
  await waitForBrowser("Boolean(document.querySelector('.input-entry'))", "the question card");

  const card = await cdp.evaluate(`(() => {
    const entry = document.querySelector('.input-entry');
    const questions = [...entry.querySelectorAll('[data-input-question]')].map((block) => ({
      id: block.dataset.inputQuestion,
      multi: block.dataset.inputMulti === '1',
      prompt: block.querySelector('.input-prompt')?.textContent?.trim() ?? '',
      header: block.querySelector('.input-header')?.textContent?.trim() ?? '',
      options: [...block.querySelectorAll('[data-input-option]')].map((input) => ({
        label: input.value,
        type: input.type,
        height: Math.round(input.closest('label').getBoundingClientRect().height),
        visible: input.offsetParent !== null,
      })),
      custom: Boolean(block.querySelector('[data-input-custom]')),
    }));
    const rect = entry.getBoundingClientRect();
    return {
      heading: entry.querySelector('strong')?.textContent?.trim() ?? '',
      questions,
      submit: Boolean(entry.querySelector('[data-input-submit]')),
      cancel: Boolean(entry.querySelector('[data-input-cancel]')),
      hasAnswering: entry.textContent.includes('Agent 在等你回答'),
      withinViewport: rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1,
      viewportWidth: document.documentElement.clientWidth,
    };
  })()`);

  if (!card.hasAnswering) problems.push("the card does not announce that the agent is waiting for an answer");
  if (!card.submit || !card.cancel) problems.push("the card is missing its 提交回答 / 跳过 buttons");
  if (!card.withinViewport) problems.push(`the card overflows the ${card.viewportWidth}px phone viewport`);
  if (card.questions.length !== 2) problems.push(`the card rendered ${card.questions.length} questions, expected 2`);
  const mode = card.questions.find((question) => question.id === "mode");
  const checks = card.questions.find((question) => question.id === "checks");
  if (!mode) problems.push("the single-choice question is missing");
  if (!checks) problems.push("the multi-select question is missing");
  if (mode) {
    if (mode.prompt !== "用哪个存储？") problems.push(`unexpected prompt: ${JSON.stringify(mode.prompt)}`);
    if (mode.header !== "存储选择") problems.push(`unexpected header: ${JSON.stringify(mode.header)}`);
    if (mode.multi) problems.push("the single-choice question rendered as multi-select");
    if (mode.options.map((option) => option.label).join(",") !== "SQLite,Postgres") problems.push(`unexpected options: ${JSON.stringify(mode.options.map((option) => option.label))}`);
    if (mode.options.some((option) => option.type !== "radio")) problems.push("the single-choice options are not radios");
    if (mode.options.some((option) => !option.visible)) problems.push("a single-choice option is not visible");
    if (mode.options.some((option) => option.height < 28)) problems.push(`an option row is only ${mode.options.map((option) => option.height).join("/")}px tall`);
  }
  if (checks) {
    if (!checks.multi) problems.push("the multi-select question rendered as single-choice");
    if (checks.options.map((option) => option.label).join(",") !== "lint,test,typecheck") problems.push(`unexpected multi options: ${JSON.stringify(checks.options.map((option) => option.label))}`);
    if (checks.options.some((option) => option.type !== "checkbox")) problems.push("the multi-select options are not checkboxes");
  }

  // Pick answers the way a thumb would: click the labels, not the hidden inputs.
  await cdp.evaluate(`(() => {
    const pick = (questionId, label) => {
      const block = document.querySelector('[data-input-question="' + questionId + '"]');
      const label_ = [...block.querySelectorAll('[data-input-option]')].find((input) => input.value === label);
      label_.closest('label').click();
    };
    pick('mode', 'Postgres');
    pick('checks', 'lint');
    pick('checks', 'typecheck');
  })()`);
  const selected = await cdp.evaluate(`[...document.querySelectorAll('[data-input-option]')].filter((input) => input.checked).map((input) => input.value)`);
  if (selected.join(",") !== "Postgres,lint,typecheck") problems.push(`clicking the labels did not check the boxes: ${JSON.stringify(selected)}`);

  await cdp.evaluate("document.querySelector('.input-entry [data-input-submit]').click()");

  let answerCommand = null;
  const pollDeadline = Date.now() + 10_000;
  while (Date.now() < pollDeadline && !answerCommand) {
    const polled = await (await fetch(`${origin}${registration.channel.pollPath}?after=0`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    answerCommand = (polled.commands ?? []).find((command) => command.kind === "answer-question");
    if (!answerCommand) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!answerCommand) {
    const toast = await cdp.evaluate("document.querySelector('#toast')?.textContent ?? ''");
    problems.push(`the answer never reached the desktop companion (the phone said: ${JSON.stringify(toast)})`);
  } else {
    if (answerCommand.rpcId !== "rpc-question-submit") problems.push(`the answer carried rpcId ${answerCommand.rpcId}`);
    const expected = [{ id: "mode", selected: ["Postgres"] }, { id: "checks", selected: ["lint", "typecheck"] }];
    if (JSON.stringify(answerCommand.answers) !== JSON.stringify(expected)) {
      problems.push(`the answer body was ${JSON.stringify(answerCommand.answers)}, expected ${JSON.stringify(expected)}`);
    }
    // Confirming is what settles the phone's waiting promise.
    const confirmed = await fetch(`${origin}${registration.channel.resultsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: answerCommand.requestId, result: { ok: true } }),
    });
    if (confirmed.status !== 202) problems.push(`confirming the answer returned ${confirmed.status}`);
  }
  // The card must stop being answerable once the bridge records the outcome: the
  // options stay readable, the buttons go, and the outcome is named.
  try {
    await waitForBrowser("Boolean(document.querySelector('.input-entry.is-settled'))", "the answered card to settle", 8_000);
  } catch (error) {
    const diagnostic = await cdp.evaluate(`(() => ({
      transcript: document.querySelector('#event-log')?.textContent?.trim().slice(-400) ?? '',
      cardHtml: document.querySelector('.input-entry')?.outerHTML?.slice(0, 400) ?? '',
      toast: document.querySelector('#toast')?.textContent ?? '',
      toastHidden: document.querySelector('#toast')?.hidden ?? null,
      problems: ${JSON.stringify(problems)},
    }))()`);
    const stored = bridge.eventStore.listAfter(0, { sessionId }).map((event) => `${event.kind}${event.payload?.outcome ? `:${event.payload.outcome}` : ""}`);
    console.error("DIAGNOSTIC transcript:", JSON.stringify(diagnostic.transcript));
    console.error("DIAGNOSTIC toast:", JSON.stringify(diagnostic.toast), "hidden:", diagnostic.toastHidden);
    console.error("DIAGNOSTIC problems so far:", JSON.stringify(diagnostic.problems));
    console.error("DIAGNOSTIC bridge events:", JSON.stringify(stored));
    throw error;
  }
  const settled = await cdp.evaluate(`(() => {
    const card = document.querySelector('.input-entry.is-settled');
    return {
      text: card ? card.textContent : '',
      buttons: document.querySelectorAll('.input-entry [data-input-submit], .input-entry [data-input-cancel]').length,
      inputs: document.querySelectorAll('.input-entry [data-input-option]').length,
      custom: document.querySelectorAll('.input-entry [data-input-custom]').length,
      outcome: card?.querySelector('.input-settled')?.textContent?.trim() ?? '',
    };
  })()`);
  if (!settled.text.includes("用哪个存储？")) problems.push("the settled card lost its question text");
  if (settled.buttons !== 0) problems.push(`the settled card still offers ${settled.buttons} buttons`);
  if (settled.inputs !== 0) problems.push(`the settled card still renders ${settled.inputs} clickable options`);
  if (settled.custom !== 0) problems.push("the settled card still renders a free-text input");
  if (settled.outcome !== "已回答") problems.push(`the settled card names the outcome ${JSON.stringify(settled.outcome)}`);

  // ---- Round 2: 跳过 has to reach the desktop as a cancellation ----
  await ask("rpc-question-cancel", [{
    id: "confirm",
    question: "还要继续吗？",
    options: [{ label: "继续" }, { label: "停下" }],
  }]);
  await waitForBrowser("Boolean(document.querySelector('.input-entry [data-input-cancel]'))", "the second question card");
  await cdp.evaluate("document.querySelector('.input-entry [data-input-cancel]').click()");

  let cancelCommand = null;
  const cancelDeadline = Date.now() + 10_000;
  while (Date.now() < cancelDeadline && !cancelCommand) {
    const polled = await (await fetch(`${origin}${registration.channel.pollPath}?after=0`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    cancelCommand = (polled.commands ?? []).find((command) => command.kind === "cancel-question");
    if (!cancelCommand) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!cancelCommand) problems.push("跳过 never reached the desktop companion as a cancel-question");
  else {
    if (cancelCommand.rpcId !== "rpc-question-cancel") problems.push(`the cancel carried rpcId ${cancelCommand.rpcId}`);
    // 桌面端必须确认，否则手机那次请求会挂到超时（504）。
    const cancelled = await fetch(`${origin}${registration.channel.resultsPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: cancelCommand.requestId, result: { ok: true } }),
    });
    if (cancelled.status !== 202) problems.push(`confirming the skip returned ${cancelled.status}`);
    // 必须等第二张卡也 settle：第一张已经是 .is-settled，只等"存在"会立刻通过。
    await waitForBrowser("document.querySelectorAll('.input-settled').length >= 2", "the skipped card to settle");
    // 第一张卡的 .input-settled 也还在，取最后一张。
    const skipOutcome = await cdp.evaluate("[...document.querySelectorAll('.input-settled')].at(-1)?.textContent?.trim() ?? ''");
    if (skipOutcome !== "已跳过") problems.push(`the skipped card names the outcome ${JSON.stringify(skipOutcome)}`);
  }
} finally {
  cdp?.close();
  chrome.kill();
  await new Promise((resolve) => bridge.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

if (problems.length) {
  console.error("FAIL  the phone cannot reliably see and answer a desktop agent's question:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("PASS  a desktop question renders as an answerable card on the phone, and the chosen options reach the desktop in question order");
