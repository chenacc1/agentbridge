import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEBUG_PORT = Number(process.env.GUIDE_CDP_PORT ?? 9336);
const SCREENSHOT_DIR = process.env.VERIFY_SCREENSHOT_DIR || null;
const GUIDE_URL = pathToFileURL(path.resolve("docs/agentbridge-product-guide.html")).href;
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
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
  #ws;
  #id = 0;
  #pending = new Map();
  #sessionId = null;

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

  close() {
    this.#ws?.close();
  }
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const browserPath = await findBrowser();
if (!browserPath) throw new Error("Chrome or Edge was not found");
const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-guide-cdp-"));
const browser = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

let cdp;
try {
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();

  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.name === "mobile",
    });
    await cdp.send("Page.navigate", { url: GUIDE_URL });
    await waitFor(cdp, "document.readyState === 'complete'", `${viewport.name} guide load`);
    await waitFor(cdp, "[...document.images].every((image) => image.complete && image.naturalWidth > 0)", `${viewport.name} guide images`);
    await cdp.evaluate("document.querySelector('#tab-3').click()");
    await waitFor(cdp, "!document.querySelector('#step-3').hidden", `${viewport.name} step tabs`);
    await cdp.evaluate("document.querySelector('[data-action=send]').click()");
    await waitFor(cdp, "document.querySelectorAll('#phoneFeed .message').length >= 5", `${viewport.name} phone demo`);
    await cdp.evaluate("document.querySelectorAll('.layer-card')[3].click()");
    await waitFor(cdp, "document.querySelector('#layerTitle').textContent.includes('目录持久')", `${viewport.name} layer interaction`);

    const result = await cdp.evaluate(`(() => ({
      viewport: [innerWidth, innerHeight],
      documentWidth: document.documentElement.scrollWidth,
      sections: ["problem", "how", "workspace", "demo", "inside", "remote", "agents", "start"].every((id) => Boolean(document.getElementById(id))),
      workspaceImage: document.querySelector('#workspace img')?.naturalWidth ?? 0,
      mobileImage: document.querySelector('#step-3 img')?.naturalWidth ?? 0,
      remoteModes: document.querySelectorAll('.transport-card').length,
      agentRows: document.querySelectorAll('.agent-row').length,
      activeStep: document.querySelector('.tab[aria-selected="true"]')?.id,
      activeLayer: document.querySelector('.layer-card.active')?.dataset.layer,
      topnavDisplay: getComputedStyle(document.querySelector('.topnav')).display,
      transportColumns: getComputedStyle(document.querySelector('.transport-grid')).gridTemplateColumns,
    }))()`);
    if (result.documentWidth > result.viewport[0] || !result.sections || result.workspaceImage === 0 || result.mobileImage === 0 || result.remoteModes !== 4 || result.agentRows !== 5 || result.activeStep !== "tab-3" || result.activeLayer !== "3") {
      throw new Error(`${viewport.name} guide verification failed: ${JSON.stringify(result)}`);
    }
    if (viewport.name === "mobile" && result.topnavDisplay !== "none") {
      throw new Error(`mobile navigation did not collapse: ${JSON.stringify(result)}`);
    }
    console.log(`${viewport.name}: ${JSON.stringify(result)}`);

    if (SCREENSHOT_DIR) {
      await cdp.evaluate("document.querySelector('#workspace').scrollIntoView()");
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      await writeFile(path.join(SCREENSHOT_DIR, `agentbridge-guide-${viewport.name}.png`), Buffer.from(screenshot.data, "base64"));
    }
  }
} finally {
  cdp?.close();
  if (browser.exitCode === null) {
    browser.kill();
    await Promise.race([
      new Promise((resolve) => browser.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
