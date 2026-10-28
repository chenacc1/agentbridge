// End-to-end check that tables, formulas and code render as their own block type
// on a real phone-width page, in a real browser.
//
// Unit tests prove the HTML the renderer emits; this proves the page actually
// shows a table as a table, typeset math, and a code card — and that none of them
// pushes the layout sideways on a 390px viewport.
//
//   node scripts/verify-message-blocks.mjs
//   CHROME_PATH="C:\\path\\to\\chrome.exe" node scripts/verify-message-blocks.mjs
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9339);
const SCREENSHOT = process.env.VERIFY_SCREENSHOT ?? null;

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

async function waitFor(cdp, expression, { timeoutMs = 30_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const MESSAGE = [
  "## 方案对比",
  "",
  "| 方案 | 延迟 | 说明 |",
  "| --- | ---: | :---: |",
  "| 本地 | 12ms | 最快 |",
  "| 云端 | `180ms` | 受网络影响 |",
  "",
  "压缩率约 $r = \\frac{n}{N}$，价格 $5 与 $10 不是公式。",
  "",
  "$$",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "$$",
  "",
  "```python",
  "def compress(data):",
  "    return data[: len(data) // 2]",
  "```",
].join("\n");

const browserPath = await findBrowser();
if (!browserPath) {
  console.error("No Chrome or Edge binary was found. Set CHROME_PATH to run this verification.");
  process.exit(2);
}

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-blocks-"));
const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-blocks-profile-"));
const config = {
  host: "127.0.0.1",
  port: 0,
  advertisedOrigin: "http://127.0.0.1:0",
  secureCookies: false,
  dataDir: directory,
  projects: new Map([["demo", directory]]),
  pairingTtlMs: 60_000,
  sessionTtlMs: 600_000,
  machineName: "Blocks machine",
};
const bridge = await createBridge({ config });
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;

const registration = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "blocks-session-1", cwd: directory, title: "blocks" }),
})).json();
const { id: channelId, token } = registration.channel;
const sessionId = registration.session.id;

const browser = spawn(browserPath, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });

let exitCode = 0;
let cdp;
try {
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await waitFor(cdp, "!!document.querySelector('#app') && !document.querySelector('#app').hidden", { label: "the console shell" });
  // The drawer owns navigation now: open it on a phone, then pick the conversation.
  await waitFor(cdp, "document.querySelectorAll('#drawer-tree [data-session]').length > 0", { label: "the drawer tree" });
  await cdp.evaluate(`(() => {
    const drawer = document.querySelector('#agent-drawer');
    if (!drawer.classList.contains('open')) document.querySelector('#drawer-toggle').click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelectorAll('#drawer-tree [data-session]').length > 0", { label: "the conversation row" });
  await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#drawer-tree [data-session]')];
    const row = rows.find((element) => element.dataset.session === ${JSON.stringify(sessionId)}) ?? rows[0];
    row?.click();
    return Boolean(row);
  })()`);
  await waitFor(cdp, "!document.querySelector('#session-view').hidden", { label: "the conversation pane" });

  // Push one agent message containing all three block types through the real
  // Desktop channel, then wait for the page to finish rendering it.
  const before = await cdp.evaluate("document.querySelectorAll('#event-log .event-entry').length");
  await fetch(`${origin}${registration.channel.eventsPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [
      { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }, origin: "desktop" },
      {
        event: {
          type: "assistant/message",
          seq: 2,
          time: 2,
          data: { turn: 1, step: 1, message: { content: [{ type: "text", text: MESSAGE }], source: { kind: "model", provider: "test", model: "test" } } },
        },
        origin: "desktop",
      },
      { event: { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } }, origin: "desktop" },
    ] }),
  });
  await waitFor(cdp, `document.querySelectorAll('#event-log .event-entry').length > ${before}`, { label: "the message entry" });
  // KaTeX is fetched lazily, so wait for the formula to be typeset.
  await waitFor(cdp, "!!document.querySelector('#event-log .katex')", { timeoutMs: 20_000, label: "the typeset formula" });
  // KaTeX only looks right with its own fonts, and they are served by this bridge.
  await cdp.evaluate("document.fonts.ready.then(() => true)");

  const report = await cdp.evaluate(`(() => {
    const log = document.querySelector('#event-log');
    const table = log.querySelector('.md-table');
    const wrap = log.querySelector('.md-table-wrap');
    const code = log.querySelector('.md-code');
    const math = log.querySelector('.md-math');
    const numeric = table ? [...table.querySelectorAll('th')].map((cell) => cell.style.textAlign) : [];
    const background = (element) => (element ? getComputedStyle(element).backgroundImage + getComputedStyle(element).backgroundColor : "");
    return {
      tables: log.querySelectorAll('.md-table').length,
      headCells: table ? table.querySelectorAll('thead th').length : 0,
      bodyRows: table ? table.querySelectorAll('tbody tr').length : 0,
      numericAlign: numeric,
      tableScrolls: Boolean(wrap && wrap.scrollWidth >= wrap.clientWidth),
      codeCards: log.querySelectorAll('.md-code').length,
      codeLang: log.querySelector('.md-code-lang')?.textContent ?? null,
      copyButtons: log.querySelectorAll('[data-copy-code]').length,
      tokenKinds: [...new Set([...log.querySelectorAll('.md-code [class^="tok-"]')].map((el) => el.className))],
      codeText: log.querySelector('.md-code code')?.textContent ?? null,
      displayMath: log.querySelectorAll('.md-math').length,
      katexNodes: log.querySelectorAll('.katex').length,
      mathText: math?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? null,
      currencyKept: log.innerText.includes("$5 与 $10"),
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      codeOverflowsCard: code ? code.scrollWidth > code.clientWidth + 1 : null,
      // Visual separation, not just structure: each block must look unlike prose.
      codeBackground: background(code),
      proseBackground: background(log.querySelector('.message-markdown p')),
      headerBackground: background(log.querySelector('.md-table th')),
      cellBackground: background(log.querySelector('.md-table td')),
      mathAligned: math ? getComputedStyle(math).textAlign : null,
      mathFontLoaded: document.fonts.check('1em KaTeX_Main'),
    };
  })()`);

  const checks = [
    ["table rendered", report.tables === 1],
    ["table has 3 head cells", report.headCells === 3],
    ["table has 2 body rows", report.bodyRows === 2],
    ["numeric column right-aligned", report.numericAlign[1] === "right"],
    ["centre column centred", report.numericAlign[2] === "center"],
    ["table scrolls inside its own box", report.tableScrolls === true],
    ["code card rendered once", report.codeCards === 1],
    ["code card shows its language", report.codeLang === "python"],
    ["code card offers copy", report.copyButtons === 1],
    ["code is syntax coloured", report.tokenKinds.includes("tok-keyword") && report.tokenKinds.length >= 2],
    ["colouring keeps the exact source", report.codeText === "def compress(data):\n    return data[: len(data) // 2]"],
    ["display formula rendered once", report.displayMath === 1],
    ["formula is typeset by KaTeX", report.katexNodes >= 2],
    ["currency stayed text", report.currencyKept === true],
    ["page does not scroll sideways", report.pageOverflow <= 0],
    ["code card looks unlike prose", report.codeBackground !== report.proseBackground && report.codeBackground !== ""],
    ["table header looks unlike body cells", report.headerBackground !== report.cellBackground],
    ["display formula is centred", report.mathAligned === "center"],
    ["KaTeX font actually loaded", report.mathFontLoaded === true],
  ];
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) exitCode = 1;
  }
  console.log(`info  page overflow: ${report.pageOverflow}px, formula text: ${report.mathText}`);

  if (SCREENSHOT) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(SCREENSHOT, Buffer.from(shot.data, "base64"));
    console.log(`info  screenshot: ${SCREENSHOT}`);
  }
} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
