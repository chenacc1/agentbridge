import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9335);
const SCREENSHOT_DIR = process.env.VERIFY_SCREENSHOT_DIR || null;
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

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const browserPath = await findBrowser();
if (!browserPath) throw new Error("Chrome or Edge was not found");
const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-workspace-ui-"));
const alphaDirectory = path.join(directory, "AgentBridge 产品演示");
const betaDirectory = path.join(directory, "视频工作流");
await mkdir(alphaDirectory);
await mkdir(betaDirectory);
const config = {
  host: "127.0.0.1",
  port: 0,
  advertisedOrigin: "http://127.0.0.1:0",
  secureCookies: false,
  dataDir: path.join(directory, "data"),
  projects: new Map([["alpha", alphaDirectory], ["beta", betaDirectory]]),
  pairingTtlMs: 60_000,
  sessionTtlMs: 600_000,
  machineName: "Workspace UI verification",
};
const bridge = await createBridge({ config });
const device = { id: "verify-device", deviceName: "Verification" };
await bridge.sessions.create({ adapterId: "echo", projectAlias: "alpha", title: "Alpha planning", commandId: "verify-alpha-one", device });
await bridge.sessions.create({ adapterId: "echo", projectAlias: "alpha", title: "Alpha implementation", commandId: "verify-alpha-two", device });
await bridge.sessions.create({ adapterId: "echo", projectAlias: "beta", title: "Beta review", commandId: "verify-beta-one", device });
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = login.headers.get("set-cookie").split(";", 1)[0];
const sessionToken = decodeURIComponent(cookie.split("=").slice(1).join("="));
const alphaWorkspace = bridge.workspaceCatalog.get("alpha");
const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-workspace-cdp-"));
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
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: sessionToken, domain: "127.0.0.1", path: "/" });
  if (SCREENSHOT_DIR) await mkdir(SCREENSHOT_DIR, { recursive: true });

  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.name === "mobile",
    });
    await cdp.send("Page.navigate", { url: `${origin}/` });
    await waitFor(cdp, "document.querySelectorAll('#workspace-list .workspace-row').length === 2", `${viewport.name} workspace navigation`);
    // The loopback-only desktop pairing panel is intentionally present in this
    // local fixture. Hide it for the screenshot so both captures inspect the
    // workspace/session surface a remote paired phone actually operates.
    await cdp.evaluate("document.querySelector('#desktop-pairing').hidden = true; document.querySelector('#return-entry').hidden = true");
    await cdp.evaluate(`document.querySelector('[data-workspace-id="${alphaWorkspace.id}"]').click()`);
    await waitFor(cdp, "document.querySelector('#project-select').value === 'alpha' && document.querySelectorAll('#session-list .session-row').length === 2", `${viewport.name} alpha sessions`);
    await cdp.evaluate("document.querySelector('#new-session-toggle').click()");
    await waitFor(cdp, "!document.querySelector('#new-session-form').hidden", `${viewport.name} new conversation form`);
    const result = await cdp.evaluate(`(() => ({
      viewport: [innerWidth, innerHeight],
      documentWidth: document.documentElement.scrollWidth,
      workspaceRows: document.querySelectorAll('#workspace-list .workspace-row').length,
      sessionRows: document.querySelectorAll('#session-list .session-row').length,
      activeWorkspace: document.querySelector('#workspace-list [aria-current="true"] strong')?.textContent,
      projectValue: document.querySelector('#project-select').value,
      formFitsViewport: document.querySelector('#new-session-form').getBoundingClientRect().right <= innerWidth,
      syncLabel: document.querySelector('#discover-conversations span')?.textContent,
      syncHidden: document.querySelector('#discover-conversations').hidden,
    }))()`);
    if (result.documentWidth > result.viewport[0] || result.workspaceRows !== 2 || result.sessionRows !== 2 || result.projectValue !== "alpha" || !result.formFitsViewport) {
      throw new Error(`${viewport.name} verification failed: ${JSON.stringify(result)}`);
    }
    await cdp.evaluate("document.querySelector('#new-session-toggle').click()");
    console.log(`${viewport.name}: ${JSON.stringify(result)}`);
    if (SCREENSHOT_DIR) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      await writeFile(path.join(SCREENSHOT_DIR, `agentbridge-workspaces-${viewport.name}.png`), Buffer.from(screenshot.data, "base64"));
    }
  }
} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
