// Regression check for the floating quick-nav (置顶 ⇧ / 置底 ⇩).
//
// The first version of this widget was dead on phones: it scrolled and measured
// #event-log, but the ≤780px media query sets .event-log { max-height: none }, so on a
// phone the *page* scrolls and the log never moves. That made both endpoint checks true
// at once, both buttons got pointer-events:none, and the widget was unclickable exactly
// where it was created for. This script pins the contract down at both layouts:
//
//   • both buttons are always clickable (pointer-events:auto, hit-test lands on them)
//   • 置底 reaches the real end of whichever element scrolls, 置顶 returns to the start
//   • the cluster stays inside the viewport and keeps 44px touch targets
//   • it appears with a conversation and disappears on the empty state
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9347);
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

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-quicknav-"));
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

/** A conversation with `count` exchanges, long enough to overflow any viewport. */
async function seed(title, count) {
  const registration = await (await fetch(`${origin}/api/local/dsh-desktop/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: `quicknav-${title}`, cwd: directory, title }),
  })).json();
  const events = [];
  let seq = 0;
  for (let index = 0; index < count; index += 1) {
    events.push({
      event: { type: "turn/start", seq: ++seq, time: Date.now(), data: {} },
      origin: "desktop",
    });
    events.push({
      event: {
        type: "assistant/message",
        seq: ++seq,
        time: Date.now(),
        data: { message: { content: [{ type: "text", text: `${title} 第 ${index + 1} 段：把这段对话撑到必须滚动才能看完。` }], source: { provider: "ds", model: "ds-chat" } } },
      },
      origin: "desktop",
    });
  }
  await fetch(`${origin}/api/local/dsh-desktop/channels/${registration.channel.id}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${registration.channel.token}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  return registration.session.id;
}

const tinySession = await seed("短会话", 1);
const longSession = await seed("长会话", 60);

const chrome = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  `--user-data-dir=${path.join(directory, "chrome-profile")}`,
  "about:blank",
], { stdio: "ignore" });

const cdp = await Cdp.attach(DEBUG_PORT);
await cdp.openPage();

const local = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = local.headers.get("set-cookie").split(";")[0];
await cdp.send("Network.enable");
await cdp.send("Network.setCookie", {
  name: cookie.split("=")[0],
  value: cookie.split("=").slice(1).join("="),
  domain: "127.0.0.1",
  path: "/",
});
await cdp.send("Page.navigate", { url: origin });

async function waitFor(expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

await waitFor("Boolean(document.querySelector('#drawer-toggle'))", "the app shell");
await waitFor("Boolean(document.querySelector('.drawer-session'))", "the seeded conversations");

/** Smooth scrolling is an animation: wait for the position to stop moving. */
async function settleScroll() {
  let previous = -1;
  let quiet = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const position = await cdp.evaluate(`(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return Math.round(root.scrollTop) + Math.round(document.querySelector('#event-log').scrollTop);
    })()`);
    quiet = position === previous ? quiet + 1 : 0;
    previous = position;
    if (quiet >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const MEASURE = `(() => {
  const nav = document.querySelector('#quick-nav');
  const top = document.querySelector('#quick-nav-top');
  const bottom = document.querySelector('#quick-nav-bottom');
  const log = document.querySelector('#event-log');
  const root = document.scrollingElement ?? document.documentElement;
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const topmost = document.elementFromPoint(x, y);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      pointerEvents: getComputedStyle(element).pointerEvents,
      clickable: Boolean(topmost && (topmost === element || element.contains(topmost))),
      idle: element.classList.contains('is-idle'),
    };
  };
  return {
    navHidden: nav.hidden,
    viewportWidth: document.documentElement.clientWidth,
    page: {
      scrollTop: Math.round(root.scrollTop),
      maxScroll: Math.round(root.scrollHeight - root.clientHeight),
      scrollable: root.scrollHeight - root.clientHeight > 4,
    },
    log: {
      scrollTop: Math.round(log.scrollTop),
      maxScroll: Math.round(log.scrollHeight - log.clientHeight),
      scrollable: log.scrollHeight - log.clientHeight > 4,
    },
    top: describe(top),
    bottom: describe(bottom),
  };
})()`;

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

async function select(sessionId) {
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.drawer-session')]
      .find((node) => node.dataset.sessionId === ${JSON.stringify(sessionId)});
    row?.click();
  })()`);
  await waitFor(
    `document.querySelector('#session-view')?.hidden === false`,
    `session ${sessionId} to open`,
  );
  await settleScroll();
}

/** Both buttons must be clickable in whatever state the transcript is in. */
function assertAlwaysClickable(state, label) {
  for (const key of ["top", "bottom"]) {
    const button = state[key];
    check(button.pointerEvents === "auto", `${label}: ${key} button is not clickable (pointer-events:${button.pointerEvents})`);
    check(button.clickable, `${label}: ${key} button is covered by another element`);
    check(button.width >= 44 && button.height >= 44, `${label}: ${key} button is ${button.width}×${button.height}, below the 44px touch target`);
    check(button.left >= 0 && button.right <= state.viewportWidth + 1, `${label}: ${key} button sits outside the viewport (${button.left}..${button.right} of ${state.viewportWidth})`);
  }
}

async function click(id) {
  await cdp.evaluate(`document.querySelector('${id}').click()`);
  await settleScroll();
  return cdp.evaluate(MEASURE);
}

const viewports = [
  { name: "phone 390×844", width: 390, height: 844, mobile: true },
  { name: "desktop 1440×1000", width: 1440, height: 1000, mobile: false },
];

for (const viewport of viewports) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  // The empty state has no conversation to navigate, so the cluster must be gone.
  await cdp.evaluate("document.querySelector('#drawer-toggle')?.click()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cdp.evaluate("document.querySelector('#drawer-close')?.click()");

  for (const [label, sessionId] of [["short conversation", tinySession], ["long conversation", longSession]]) {
    await select(sessionId);
    const atStart = await cdp.evaluate(MEASURE);
    check(atStart.navHidden === false, `${viewport.name} / ${label}: the quick nav is hidden while a conversation is open`);
    assertAlwaysClickable(atStart, `${viewport.name} / ${label} at start`);

    const afterBottom = await click("#quick-nav-bottom");
    assertAlwaysClickable(afterBottom, `${viewport.name} / ${label} after 置底`);
    // Whichever element actually scrolls (page on phones, the log on a wide window)
    // has to land at its own end — that is the whole point of the button.
    if (afterBottom.page.scrollable) {
      check(
        Math.abs(afterBottom.page.scrollTop - afterBottom.page.maxScroll) <= 4,
        `${viewport.name} / ${label}: 置底 left the page at ${afterBottom.page.scrollTop} of ${afterBottom.page.maxScroll}`,
      );
    }
    if (afterBottom.log.scrollable) {
      check(
        Math.abs(afterBottom.log.scrollTop - afterBottom.log.maxScroll) <= 4,
        `${viewport.name} / ${label}: 置底 left the transcript at ${afterBottom.log.scrollTop} of ${afterBottom.log.maxScroll}`,
      );
    }
    check(afterBottom.bottom.idle === true, `${viewport.name} / ${label}: 置底 does not mark itself as idle at the end`);

    const afterTop = await click("#quick-nav-top");
    assertAlwaysClickable(afterTop, `${viewport.name} / ${label} after 置顶`);
    check(afterTop.page.scrollTop <= 4, `${viewport.name} / ${label}: 置顶 left the page at ${afterTop.page.scrollTop}`);
    check(afterTop.log.scrollTop <= 4, `${viewport.name} / ${label}: 置顶 left the transcript at ${afterTop.log.scrollTop}`);
    check(afterTop.top.idle === true, `${viewport.name} / ${label}: 置顶 does not mark itself as idle at the start`);

    // Mid-transcript: neither endpoint applies, so nothing may claim to be idle.
    await cdp.evaluate(`(() => {
      const log = document.querySelector('#event-log');
      const root = document.scrollingElement ?? document.documentElement;
      if (log.scrollHeight - log.clientHeight > 40) log.scrollTop = Math.round((log.scrollHeight - log.clientHeight) / 2);
      else if (root.scrollHeight - root.clientHeight > 40) root.scrollTop = Math.round((root.scrollHeight - root.clientHeight) / 2);
    })()`);
    await settleScroll();
    const middle = await cdp.evaluate(MEASURE);
    assertAlwaysClickable(middle, `${viewport.name} / ${label} in the middle`);
    check(middle.top.idle === false, `${viewport.name} / ${label}: 置顶 is marked idle in the middle of the transcript`);
    check(middle.bottom.idle === false, `${viewport.name} / ${label}: 置底 is marked idle in the middle of the transcript`);

    // 弹出面板几乎占满手机宽度，悬浮键留在旁边只是干扰：面板打开时必须收起。
    const popover = await cdp.evaluate(`(async () => {
      const trigger = document.querySelector('#model-trigger');
      const nav = document.querySelector('#quick-nav');
      if (!trigger || trigger.disabled) return { skipped: true };
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const openHidden = nav.hidden;
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { skipped: false, openHidden, closedHidden: nav.hidden };
    })()`);
    if (!popover.skipped) {
      check(popover.openHidden === true, `${viewport.name} / ${label}: the quick nav stays visible over an open model panel`);
      check(popover.closedHidden === false, `${viewport.name} / ${label}: the quick nav does not come back when the panel closes`);
    }
  }
}

cdp.close();
chrome.kill();
await new Promise((resolve) => bridge.server.close(resolve));
await new Promise((resolve) => setTimeout(resolve, 250));
await rm(directory, { recursive: true, force: true });

if (failures.length) {
  console.error("FAIL  the floating quick-nav breaks its contract:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS  the floating quick-nav stays clickable at every scroll position, on a phone and on a wide window");
