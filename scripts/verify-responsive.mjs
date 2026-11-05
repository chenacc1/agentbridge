// Phone-width adaptation: nothing may stick out past the screen.
//
// The reported symptom was a WeChat/Android device where the session header, the model
// row and the composer were all clipped on the right — "some conversations" only. The
// cause was structural: `.session-view`'s implicit grid column sized itself to the header's
// min-content (the nowrap project badges), so the whole view grew wider than the screen.
// Desktop never showed it; a phone with text autosizing did.
//
// This script seeds a deliberately hostile conversation (very long title, project alias
// and model name) and checks, at the narrow widths phones actually report, that the
// document does not scroll sideways and that the composer stays inside the viewport.
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9352);
const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

async function findBrowser() {
  for (const candidate of CANDIDATES) {
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

const PROJECT_ALIAS = "boujoy-harness-main-2026-01-15-rc";
const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-responsive-"));
const projectDir = path.join(directory, "project");
const config = {
  host: "127.0.0.1",
  port: 0,
  advertisedOrigin: "http://127.0.0.1:0",
  secureCookies: false,
  dataDir: directory,
  projects: new Map([[PROJECT_ALIAS, projectDir]]),
  pairingTtlMs: 60_000,
  sessionTtlMs: 600_000,
  machineName: "Verify machine",
};
const { mkdir } = await import("node:fs/promises");
await mkdir(projectDir, { recursive: true });
const bridge = await createBridge({ config });
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;

// Hostile but realistic: the longest names this app has ever been seen with.
const registration = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sessionId: "responsive-session",
    cwd: projectDir,
    title: "boujoy-harness-main · DSH Desktop",
    provider: "deepseek",
    model: "deepseek-v4-flash-vision-exp",
    modelDirectory: {
      current: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp", reasoningEffort: "high" },
      routable: true,
      groups: [{
        id: "deepseek",
        name: "DeepSeek",
        models: [{
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
          reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" },
        }],
      }],
      failures: [],
    },
  }),
})).json();
await fetch(`${origin}${registration.channel.eventsPath}`, {
  method: "POST",
  headers: { authorization: `Bearer ${registration.channel.token}`, "content-type": "application/json" },
  body: JSON.stringify({ events: [
    { event: { type: "turn/start", seq: 1, time: Date.now(), data: {} }, origin: "desktop" },
    { event: { type: "assistant/message", seq: 2, time: Date.now(), data: { message: { content: [{ type: "text", text: "宽度适配测试。" }], source: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" } } } }, origin: "desktop" },
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
  const token = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: token, domain: "127.0.0.1", path: "/" });

  const MEASURE = `(() => {
    const doc = document.documentElement;
    const clientWidth = doc.clientWidth;
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    };
    // Anything that paints past the right edge and is not a deliberate off-screen overlay.
    // The pairing card and the return strip only exist on the loopback desktop panel, so
    // they are not part of the phone layout this check is about.
    const offenders = [];
    for (const element of document.querySelectorAll('#app *')) {
      if (element.closest('#desktop-pairing, #return-entry')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.position === 'fixed' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > clientWidth + 1) {
        const name = element.id ? '#' + element.id : (typeof element.className === 'string' && element.className.trim()
          ? '.' + element.className.trim().split(/\\s+/).join('.') : element.tagName.toLowerCase());
        offenders.push({ node: name, right: Math.round(rect.right) });
      }
    }
    return {
      clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      docScrollWidth: doc.scrollWidth,
      sessionView: box('#session-view'),
      header: box('.session-header'),
      meta: box('.session-meta'),
      modelRow: box('#model-control'),
      composer: box('#composer'),
      send: box('.send-button'),
      offenders: offenders.slice(0, 10),
    };
  })()`;

  for (const width of [320, 360, 375, 393, 412, 430]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Page.navigate", { url: origin });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#drawer-tree'))")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await cdp.evaluate(`(() => {
      document.querySelector('#desktop-pairing')?.setAttribute('hidden', '');
      document.querySelector('#return-entry')?.setAttribute('hidden', '');
    })()`);
    await cdp.evaluate(`(() => {
      const agent = document.querySelector('#drawer-tree .drawer-agent[data-agent="deepseek-harness-desktop"]');
      if (agent && agent.getAttribute('aria-expanded') !== 'true') agent.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await cdp.evaluate("[...document.querySelectorAll('#drawer-tree [data-session]')][0]?.click()");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await cdp.evaluate("document.querySelector('#drawer-close')?.click()");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const measured = await cdp.evaluate(MEASURE);
    console.log(`${width}px: ${JSON.stringify(measured)}`);
    if (measured.sessionView?.width > measured.clientWidth + 1) {
      problems.push(`${width}px: the conversation view is ${measured.sessionView.width}px wide in a ${measured.clientWidth}px viewport`);
    }
    if (measured.bodyScrollWidth > measured.clientWidth + 1) {
      problems.push(`${width}px: the page scrolls sideways (${measured.bodyScrollWidth} > ${measured.clientWidth})`);
    }
    if (measured.docScrollWidth > measured.clientWidth + 1) {
      problems.push(`${width}px: the document is ${measured.docScrollWidth}px wide in a ${measured.clientWidth}px viewport`);
    }
    if (measured.offenders.length) {
      problems.push(`${width}px: elements paint past the right edge: ${JSON.stringify(measured.offenders)}`);
    }
    if (!measured.composer) problems.push(`${width}px: the composer is missing`);
    else {
      if (measured.composer.right > measured.clientWidth + 1) problems.push(`${width}px: the composer ends at ${measured.composer.right}px in a ${measured.clientWidth}px viewport`);
      if (measured.send && measured.send.right > measured.composer.right + 1) problems.push(`${width}px: the send button sticks out of the composer`);
      if (measured.composer.width > measured.clientWidth + 1) problems.push(`${width}px: the composer is ${measured.composer.width}px wide`);
    }
  }
} finally {
  cdp?.close();
  chrome.kill();
  await new Promise((resolve) => bridge.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

if (problems.length) {
  console.error("FAIL  the layout does not fit a phone screen:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("PASS  every phone width keeps the conversation, the model row and the composer inside the screen");
