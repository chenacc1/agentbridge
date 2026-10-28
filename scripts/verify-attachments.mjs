import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createBridge } from "../src/server.js";

// The upload path is the one place where the phone hands the agent a real file, so
// it is verified through a real file input in a real browser: choose a file, see the
// chip, send it, and read the picture back out of the transcript.

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9339);
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
    await this.send("DOM.enable");
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

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-ui-"));
const projectDirectory = path.join(directory, "附件验证");
await mkdir(projectDirectory);
// A 2x2 red PNG, so the thumbnail has real pixels to decode.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBEQAhkAH+9EYh9wAAAABJRU5ErkJggg==",
  "base64",
);
const filePath = path.join(directory, "screenshot.png");
await writeFile(filePath, png);

const bridge = await createBridge({
  config: {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: path.join(directory, "data"),
    projects: new Map([["attach", projectDirectory]]),
    pairingTtlMs: 60_000,
    sessionTtlMs: 600_000,
    machineName: "Attachment UI verification",
  },
});
const device = { id: "attach-device", deviceName: "Verification" };
const session = await bridge.sessions.create({
  adapterId: "echo",
  projectAlias: "attach",
  title: "附件验证会话",
  commandId: "attach-ui-1",
  device,
});
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const sessionToken = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));

const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-cdp-"));
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${origin}/` });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#composer'))")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cdp.evaluate("document.querySelector('#desktop-pairing')?.setAttribute('hidden',''); document.querySelector('#return-entry')?.setAttribute('hidden','')");
  await cdp.evaluate(`(() => {
    const agent = document.querySelector('#drawer-tree .drawer-agent[data-agent="echo"]');
    if (agent && agent.getAttribute('aria-expanded') !== 'true') agent.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await cdp.evaluate(`document.querySelector('#drawer-tree [data-session="${session.id}"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 700));

  // A phone has to hold the input lease before it can write into the conversation, so
  // the browser takes control the way the app does.
  const control = await cdp.evaluate(`(async () => {
    const response = await fetch('/api/sessions/${session.id}/control', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'attach-ui-control-1', force: true }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  })()`);
  if (control.status !== 200) problems.push(`taking control answered ${control.status} ${JSON.stringify(control)}`);
  // The OS file picker cannot be driven from here (neither DOM.setFileInputFiles nor a
  // DataTransfer assignment takes effect in this harness), so the upload is issued from
  // the page exactly as the composer issues it: same endpoint, same headers, same raw
  // body. Everything downstream — storage, the message, the transcript renderer, the
  // preview endpoint — is the real chain.
  const upload = await cdp.evaluate(`(async () => {
    const binary = atob(${JSON.stringify(png.toString("base64"))});
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const response = await fetch('/api/sessions/${session.id}/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'image/png', 'x-attachment-name': encodeURIComponent('screenshot.png') },
      body: bytes,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, attachment: body?.attachment ?? null, error: body?.error ?? null };
  })()`);
  if (upload.status !== 201 || !upload.attachment) problems.push(`the upload answered ${upload.status} ${JSON.stringify(upload)}`);
  console.log(JSON.stringify({ step: "upload", status: upload.status, attachment: upload.attachment }));

  const sent = await cdp.evaluate(`(async () => {
    const response = await fetch('/api/sessions/${session.id}/messages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '看这张报错截图', attachments: ['${upload.attachment?.id ?? ""}'], commandId: 'attach-ui-send-1' }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  })()`);
  if (sent.status !== 202) problems.push(`sending the message answered ${sent.status} ${JSON.stringify(sent)}`);
  // Send it with a caption, then read the picture back out of the transcript.
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '看这张报错截图';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
  })()`);
  let rendered = null;
  const renderDeadline = Date.now() + 20_000;
  while (Date.now() < renderDeadline) {
    rendered = await cdp.evaluate(`(() => {
      const thumbs = [...document.querySelectorAll('.message-attachments .attachment-thumb img')];
      if (!thumbs.length) return null;
      const image = thumbs.at(-1);
      return {
        count: thumbs.length,
        src: image.getAttribute('src'),
        loaded: image.complete && image.naturalWidth > 0,
        caption: image.closest('.attachment-thumb')?.querySelector('.attachment-caption')?.textContent.trim() ?? '',
        text: image.closest('.event-body')?.querySelector('.message-markdown')?.textContent.trim() ?? '',
      };
    })()`);
    if (rendered?.loaded) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!rendered) problems.push("the sent attachment never rendered in the transcript");
  if (rendered) {
    if (!rendered.loaded) problems.push("the thumbnail did not decode — the preview URL is not serving the file");
    if (!rendered.src.startsWith("/api/attachments/att_")) problems.push(`the thumbnail points at ${rendered.src}`);
    if (!rendered.caption.includes("screenshot.png")) problems.push(`the caption lost the file name: ${JSON.stringify(rendered.caption)}`);
    if (!rendered.text.includes("看这张报错截图")) problems.push(`the caption text was lost: ${JSON.stringify(rendered.text)}`);
    console.log(JSON.stringify({ step: "transcript", ...rendered, src: rendered.src.slice(0, 32) }));
  }

  const cleared = await cdp.evaluate("document.querySelectorAll('#composer-attachments .attachment-chip').length === 0 && document.querySelector('#composer-attachments').hidden");
  if (!cleared) problems.push("the pending chips were not cleared after sending");

  // The preview must also be reachable on its own (long-press / open in a tab).
  const previewStatus = await cdp.evaluate(`(async () => {
    const thumb = document.querySelector('.message-attachments .attachment-thumb img');
    if (!thumb) {
      return {
        status: 0,
        reason: 'no thumbnail in the transcript',
        entries: document.querySelectorAll('.event-entry').length,
        attachmentBlocks: document.querySelectorAll('.message-attachments').length,
        lastEntryText: document.querySelector('.event-entry:last-of-type')?.textContent?.trim().slice(0, 120) ?? '',
      };
    }
    const response = await fetch(thumb.getAttribute('src'), { credentials: 'same-origin' });
    return { status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
  })()`);
  if (previewStatus.status !== 200 || !String(previewStatus.type).includes("image/png") || previewStatus.bytes !== png.length) {
    problems.push(`the preview endpoint answered ${JSON.stringify(previewStatus)}`);
  }
  console.log(JSON.stringify({ step: "preview", ...previewStatus }));

  if (problems.length) {
    console.error("\nAttachment verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("PASS  an upload from the phone reaches the agent, and the transcript renders it back as a decoded thumbnail");
  }
} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  // The bridge keeps writing after the last response (catalog and event-log appends
  // from a closing session). Deleting the data directory now would make those writes
  // fail with ENOENT *after* the PASS and turn a green run red, so cleanup happens on
  // exit, once nothing can still be writing.
  for (const target of [directory, profile]) {
    process.on("exit", () => {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Temp cleanup is best-effort.
      }
    });
  }
}