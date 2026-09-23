// End-to-end verification of what the phone can actually display.
//
// Unit tests cover the transcript logic, but "the phone shows a whole
// conversation" is only ever true or false in a real browser, so this drives the
// real mobile page in headless Chrome over CDP against a real bridge server fed
// by the real DSH Desktop channel pipeline. It needs no dependencies: Node's
// global WebSocket speaks CDP directly.
//
//   node scripts/verify-mobile-transcript.mjs
//   CHROME_PATH="C:\\path\\to\\chrome.exe" node scripts/verify-mobile-transcript.mjs
//
// Phases:
//   A. replay - the phone opens a long conversation that already exists
//   B. live   - a reply streams while the phone is watching
//   C. commit - the streamed reply is replaced by the committed message
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9334);
const TURNS = Number(process.env.VERIFY_TURNS ?? 6);
const STEPS_PER_TURN = Number(process.env.VERIFY_STEPS ?? 5);
const DELTAS_PER_STEP = Number(process.env.VERIFY_DELTAS ?? 200);
const BATCH = 200;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

async function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
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
    throw new Error("the browser's DevTools endpoint never became available");
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener("open", () => resolve());
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

async function waitFor(cdp, expression, { timeoutMs = 60_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function settle(cdp, since, quietMs = 1200, capMs = 60_000) {
  let previous = -1;
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs && Date.now() - since < capMs) {
    const count = await cdp.evaluate("document.querySelectorAll('.event-entry').length");
    if (count !== previous) {
      previous = count;
      quietSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Date.now() - since;
}

const TRANSCRIPT = `(() => {
  const log = document.querySelector('#event-log');
  const entries = [...log.querySelectorAll('.event-entry')];
  const label = (element) => element.querySelector('strong')?.textContent ?? '';
  return {
    entries: entries.length,
    domNodes: log.querySelectorAll('*').length,
    agent: entries.filter((element) => label(element) === 'Agent').length,
    user: entries.filter((element) => label(element) === '你').length,
    streaming: entries
      .filter((element) => label(element) === 'Agent 正在回复')
      .map((element) => element.querySelector('.message-markdown')?.innerText ?? ''),
    text: log.innerText,
  };
})()`;

const NO_STREAMING_ENTRY = "![...document.querySelectorAll('#event-log .event-entry')].some((element) => element.querySelector('strong')?.textContent === 'Agent 正在回复')";

const browserPath = await findBrowser();
if (!browserPath) {
  console.error("No Chrome or Edge binary was found. Set CHROME_PATH to run this verification.");
  process.exit(2);
}

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-verify-"));
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

const registration = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "verify-session-1", cwd: directory, title: "verify" }),
})).json();
const { id: channelId, token } = registration.channel;
const sessionId = registration.session.id;

let seq = 0;
let pending = [];
async function flush() {
  if (!pending.length) return;
  const events = pending.splice(0, BATCH);
  const response = await fetch(`${origin}/api/local/dsh-desktop/channels/${channelId}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) throw new Error(`channel ingest failed with ${response.status}`);
}
async function push(event) {
  pending.push({ event, origin: "desktop" });
  if (pending.length >= BATCH) await flush();
}
const chunk = (turn, step, index, text) => ({
  type: "assistant/chunk",
  seq: ++seq,
  time: seq,
  data: { turn, step, chunk: { type: "text-delta", index, text } },
});

const expectedAssistant = [];
const expectedUser = [];
for (let turn = 1; turn <= TURNS; turn += 1) {
  await push({ type: "turn/start", seq: ++seq, time: seq, data: { turn } });
  const userText = `turn ${turn}: please do the work`;
  expectedUser.push(userText);
  await push({ type: "user/message", seq: ++seq, time: seq, data: { id: `u${turn}`, content: [{ type: "text", text: userText }] } });
  for (let step = 1; step <= STEPS_PER_TURN; step += 1) {
    let text = "";
    for (let index = 1; index <= DELTAS_PER_STEP; index += 1) {
      const piece = `t${turn}s${step}w${index} `;
      text += piece;
      await push(chunk(turn, step, index - 1, piece));
    }
    expectedAssistant.push(text);
    await push({
      type: "assistant/message",
      seq: ++seq,
      time: seq,
      data: { turn, step, message: { content: [{ type: "text", text }], source: { kind: "model", provider: "deepseek", model: "deepseek-chat" } } },
    });
  }
  await push({ type: "turn/end", seq: ++seq, time: seq, data: { turn, reason: { kind: "completed" } } });
}
await flush();

const stored = bridge.eventStore.listAfter(0).filter((event) => event.sessionId === sessionId);
console.log(`Fed ${seq} DSH events (${TURNS} turns x ${STEPS_PER_TURN} steps x ${DELTAS_PER_STEP} deltas) -> bridge stored ${stored.length} events`);
console.log(`Conversation truth: ${expectedUser.length} user + ${expectedAssistant.length} assistant replies`);

const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = login.headers.get("set-cookie").split(";", 1)[0];
const sessionToken = decodeURIComponent(cookie.split("=").slice(1).join("="));

const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-cdp-"));
const browser = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=390,844",
  "about:blank",
], { stdio: "ignore" });

let cdp;
let failed = false;
try {
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: sessionToken, domain: "127.0.0.1", path: "/" });

  const startedAt = Date.now();
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await waitFor(cdp, "document.querySelectorAll('.event-entry').length > 0", { label: "the transcript to render" });
  const replayMs = await settle(cdp, startedAt);
  const shown = await cdp.evaluate(TRANSCRIPT);
  const missingAssistant = expectedAssistant.filter((text) => !shown.text.includes(text.trim())).length;
  const missingUser = expectedUser.filter((text) => !shown.text.includes(text)).length;

  console.log(`\n--- Phase A: the phone opens a long conversation ---`);
  console.log(`Transcript settled in ${replayMs}ms; ${shown.entries} entries, ${shown.domNodes} DOM nodes`);
  console.log(`Rendered Agent replies: ${shown.agent}/${expectedAssistant.length}   user messages: ${shown.user}/${expectedUser.length}`);
  console.log(`Absent from the phone screen: assistant=${missingAssistant} user=${missingUser}`);
  const phaseA = missingAssistant === 0 && missingUser === 0 && shown.agent === expectedAssistant.length;
  console.log(`Phase A: ${phaseA ? "GREEN" : "RED"}`);
  if (!phaseA) failed = true;

  const liveTurn = TURNS + 1;
  await push({ type: "turn/start", seq: ++seq, time: seq, data: { turn: liveTurn } });
  let liveText = "";
  const groups = 6;
  const perGroup = 100;
  for (let group = 0; group < groups; group += 1) {
    for (let index = 1; index <= perGroup; index += 1) {
      const piece = `live${group}x${index} `;
      liveText += piece;
      await push(chunk(liveTurn, 1, group * perGroup + index - 1, piece));
    }
    await flush();
    // Let the bridge's coalescing window fire, so this is genuinely incremental.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const streaming = await cdp.evaluate(TRANSCRIPT);
  const streamedText = streaming.streaming.join("").trim();

  console.log(`\n--- Phase B: a reply streams while the phone watches ---`);
  console.log(`In-progress text on screen: ${streamedText.length} chars of ${liveText.trim().length}`);
  const phaseB = streamedText === liveText.trim();
  console.log(`In-progress text matches exactly: ${phaseB}`);
  if (!phaseB) {
    console.log(`  screen:   "${streamedText.slice(0, 80)}"`);
    console.log(`  expected: "${liveText.trim().slice(0, 80)}"`);
  }
  console.log(`Phase B: ${phaseB ? "GREEN" : "RED"}`);
  if (!phaseB) failed = true;

  await push({
    type: "assistant/message",
    seq: ++seq,
    time: seq,
    data: { turn: liveTurn, step: 1, message: { content: [{ type: "text", text: liveText }], source: { kind: "model", provider: "deepseek", model: "deepseek-chat" } } },
  });
  await push({ type: "turn/end", seq: ++seq, time: seq, data: { turn: liveTurn, reason: { kind: "completed" } } });
  await flush();

  const committedAt = Date.now();
  await waitFor(cdp, NO_STREAMING_ENTRY, { label: "the streamed reply to be replaced by the committed message" });
  const expectedCount = expectedAssistant.length + 1;
  await waitFor(cdp, `[...document.querySelectorAll('#event-log .event-entry')].filter((element) => element.querySelector('strong')?.textContent === 'Agent').length === ${expectedCount}`, { label: "the committed reply to render" });
  const committed = await cdp.evaluate(TRANSCRIPT);
  const committedMs = Date.now() - committedAt;

  console.log(`\n--- Phase C: the answer completes ---`);
  console.log(`Committed reply visible: ${committed.text.includes(liveText.trim())}; the screen updated ${committedMs}ms after the final chunk`);
  console.log(`Total rendered Agent replies: ${committed.agent}/${expectedCount}`);
  const phaseC = committed.text.includes(liveText.trim()) && committed.agent === expectedCount;
  console.log(`Phase C: ${phaseC ? "GREEN" : "RED"}`);
  if (!phaseC) failed = true;

  console.log(`\nResult: ${failed ? "RED" : "GREEN - the phone shows the whole conversation, live and after a reload"}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  void os;
}
