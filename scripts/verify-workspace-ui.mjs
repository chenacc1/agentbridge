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
await bridge.sessions.create({ adapterId: "echo", projectAlias: "alpha", title: "如果我想基于某个 agent 工具桌面版，例如 deepseek harness 桌面版和 chat gpt 桌面版，可以通过某种方式连接后继续工作", commandId: "verify-alpha-one", device });
await bridge.sessions.create({ adapterId: "echo", projectAlias: "alpha", title: "ID: codex/project history conversation with an intentionally long unbroken-title-segment", commandId: "verify-alpha-two", device });
const betaSession = await bridge.sessions.create({ adapterId: "echo", projectAlias: "beta", title: "Beta review", commandId: "verify-beta-one", device });
// One extra page worth of history, so "加载更早" has something real to fetch.
for (let index = 1; index <= 700; index += 1) {
  await bridge.eventStore.append("message.completed", {
    role: index % 2 === 0 ? "assistant" : "user",
    text: `beta-history-${index}`,
  }, { sessionId: betaSession.id });
}
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = login.headers.get("set-cookie").split(";", 1)[0];
const sessionToken = decodeURIComponent(cookie.split("=").slice(1).join("="));
const alphaWorkspace = bridge.workspaceCatalog.get("alpha");
const betaWorkspace = bridge.workspaceCatalog.get("beta");
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
    const phone = viewport.name === "mobile";
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: phone,
    });
    await cdp.send("Page.navigate", { url: `${origin}/` });
    // The drawer is the navigation on every width; the first thing it must show is
    // one row per Agent in the catalog, whatever the viewport.
    await waitFor(cdp, "document.querySelectorAll('#drawer-tree .drawer-agent').length > 0", `${viewport.name} drawer tree`);
    await waitFor(cdp, "!document.querySelector('#desktop-pairing').hidden && document.querySelector('#safe-shutdown')", `${viewport.name} safe shutdown control`);

    const shutdownControl = await cdp.evaluate(`(() => {
      const panel = document.querySelector('#desktop-pairing');
      const button = document.querySelector('#safe-shutdown');
      const rect = button.getBoundingClientRect();
      return {
        panelVisible: !panel.hidden,
        buttonVisible: getComputedStyle(button).display !== "none" && rect.width > 0 && rect.height > 0,
        buttonHeight: rect.height,
        buttonRight: rect.right,
        note: document.querySelector('#shutdown-note').textContent,
      };
    })()`);
    if (!shutdownControl.panelVisible || !shutdownControl.buttonVisible || shutdownControl.buttonHeight < 44 || shutdownControl.buttonRight > viewport.width) {
      throw new Error(`${viewport.name} safe shutdown layout failed: ${JSON.stringify(shutdownControl)}`);
    }
    await cdp.evaluate("document.querySelector('#safe-shutdown').click()");
    await waitFor(cdp, "document.querySelector('#safe-shutdown').classList.contains('confirming')", `${viewport.name} safe shutdown confirmation`);
    const shutdownConfirmation = await cdp.evaluate(`(() => ({
      label: document.querySelector('#safe-shutdown span').textContent,
      note: document.querySelector('#shutdown-note').textContent,
      disabled: document.querySelector('#safe-shutdown').disabled,
    }))()`);
    if (shutdownConfirmation.label !== "再次点击确认" || shutdownConfirmation.disabled || !shutdownConfirmation.note.includes("5 秒")) {
      throw new Error(`${viewport.name} safe shutdown confirmation failed: ${JSON.stringify(shutdownConfirmation)}`);
    }
    if (SCREENSHOT_DIR) {
      await cdp.evaluate("document.querySelector('#safe-shutdown').scrollIntoView({ block: 'center' })");
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      await writeFile(path.join(SCREENSHOT_DIR, `agentbridge-shutdown-${viewport.name}.png`), Buffer.from(screenshot.data, "base64"));
    }

    // 手机上"下次从这里继续"默认折叠成一行，点详情才展开，并且记住选择。
    if (phone) {
      const collapsed = await cdp.evaluate(`(() => {
        const entry = document.querySelector('#return-entry');
        return {
          hidden: entry.hidden,
          height: Math.round(entry.getBoundingClientRect().height),
          expanded: entry.classList.contains('expanded'),
          toggleLabel: document.querySelector('#toggle-return-details').textContent.trim(),
          detailsVisible: getComputedStyle(document.querySelector('#return-details')).display !== 'none',
        };
      })()`);
      if (collapsed.hidden) throw new Error(`${viewport.name}: the return strip is missing`);
      if (collapsed.expanded || collapsed.detailsVisible) throw new Error(`${viewport.name}: the return strip is not compact by default ${JSON.stringify(collapsed)}`);
      if (collapsed.height > 60) throw new Error(`${viewport.name}: the return strip still takes ${collapsed.height}px`);
      if (collapsed.toggleLabel !== "详情") throw new Error(`${viewport.name}: unexpected toggle label ${collapsed.toggleLabel}`);
      await cdp.evaluate("document.querySelector('#toggle-return-details').click()");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const expanded = await cdp.evaluate(`(() => ({
        expanded: document.querySelector('#return-entry').classList.contains('expanded'),
        detailsVisible: getComputedStyle(document.querySelector('#return-details')).display !== 'none',
        stored: localStorage.getItem('agentbridge.return.details'),
        label: document.querySelector('#toggle-return-details').textContent.trim(),
      }))()`);
      if (!expanded.expanded || !expanded.detailsVisible) throw new Error(`${viewport.name}: 详情 did not expand ${JSON.stringify(expanded)}`);
      if (expanded.stored !== "1") throw new Error(`${viewport.name}: the expanded state was not remembered`);
      await cdp.evaluate("document.querySelector('#toggle-return-details').click()");
      await new Promise((resolve) => setTimeout(resolve, 150));
      console.log(`${viewport.name} return strip: ${JSON.stringify({ collapsed, expanded })}`);
    }
    // This loopback fixture also renders the desktop pairing panel; hiding it makes
    // both captures show the surface a paired phone actually operates.
    await cdp.evaluate("document.querySelector('#desktop-pairing').hidden = true; document.querySelector('#return-entry').hidden = true; window.scrollTo(0, 0)");

    // --- 导航形态：宽屏常驻侧栏，手机覆盖层 ---
    const shell = await cdp.evaluate(`(() => {
      const drawer = document.querySelector('#agent-drawer');
      const rect = drawer.getBoundingClientRect();
      const conversation = document.querySelector('.conversation').getBoundingClientRect();
      return {
        drawerVisible: getComputedStyle(drawer).visibility !== 'hidden' && getComputedStyle(drawer).display !== 'none',
        drawerOpen: drawer.classList.contains('open'),
        drawerWidth: Math.round(rect.width),
        drawerLeft: Math.round(rect.left),
        conversationLeft: Math.round(conversation.left),
        toggleVisible: getComputedStyle(document.querySelector('#drawer-toggle')).display !== 'none',
        maskHidden: document.querySelector('#drawer-mask').hidden,
        bodyPadded: getComputedStyle(document.body).paddingLeft,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        agents: [...document.querySelectorAll('#drawer-tree .drawer-agent')].map((el) => el.dataset.agent),
        projects: document.querySelectorAll('#drawer-tree [data-project]').length,
        sessions: document.querySelectorAll('#drawer-tree [data-session]').length,
      };
    })()`);
    if (phone) {
      if (shell.drawerOpen) throw new Error(`${viewport.name}: the drawer should start closed`);
      if (!shell.toggleVisible) throw new Error(`${viewport.name}: the hamburger must be reachable`);
      if (shell.drawerWidth >= shell.viewportWidth) throw new Error(`${viewport.name}: the drawer covers the whole screen`);
      // Open it and confirm the overlay behaviour plus the tree content.
      await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
      await waitFor(cdp, "document.querySelector('#agent-drawer').classList.contains('open') && !document.querySelector('#drawer-mask').hidden", `${viewport.name} drawer open`);
    } else {
      if (!shell.drawerVisible || !shell.drawerOpen) throw new Error(`${viewport.name}: the drawer must stay open as a sidebar`);
      if (shell.toggleVisible) throw new Error(`${viewport.name}: the hamburger is redundant beside a permanent sidebar`);
      if (!shell.maskHidden) throw new Error(`${viewport.name}: no overlay mask belongs on a sidebar`);
      if (shell.conversationLeft < shell.drawerWidth - 2) throw new Error(`${viewport.name}: the conversation overlaps the sidebar (${shell.conversationLeft} < ${shell.drawerWidth})`);
    }
    // The Agent holding the newest conversation leads; every catalog Agent is
    // listed so an unavailable tool is visible instead of hidden.
    if (shell.agents[0] !== "echo") throw new Error(`${viewport.name}: expected echo first, saw ${JSON.stringify(shell.agents)}`);
    if (!shell.agents.includes("deepseek-harness-desktop")) throw new Error(`${viewport.name}: the attach-only Agent is missing`);
    if (shell.projects !== 2) throw new Error(`${viewport.name}: expected alpha and beta project rows, saw ${shell.projects}`);

    // --- 背景图：铺满裁切、遮罩存在、图片真的加载成功 ---
    const background = await cdp.evaluate(`(async () => {
      const before = getComputedStyle(document.body, '::before');
      const after = getComputedStyle(document.body, '::after');
      const loaded = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ ok: true, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ ok: false });
        image.src = '/background.jpg';
      });
      return {
        image: before.backgroundImage,
        size: before.backgroundSize,
        position: before.position,
        inset: [before.top, before.right, before.bottom, before.left],
        // The whole-page scrim is a masked "screen" lift: it adds light only where the
        // photo is dark (the mask is generated from the photo itself) and leaves the
        // bright half pixel-identical. verify-background-scrim.mjs measures the
        // resulting contrast, texture retention and colour shift in pixels.
        scrim: {
          content: after.content,
          mixBlendMode: after.mixBlendMode,
          background: after.backgroundColor,
          zIndex: after.zIndex,
          pointerEvents: after.pointerEvents,
          maskImage: after.maskImage || after.webkitMaskImage,
        },
        floor: getComputedStyle(document.documentElement).getPropertyValue('--bg-scrim-veil').trim(),
        surfaces: ['.event-entry', '.session-header', '.empty-state'].map((selector) => {
          const element = document.querySelector(selector);
          return element ? { selector, background: getComputedStyle(element).backgroundColor } : null;
        }),
        // A white glow around every glyph blurs its edges; the readable floor makes
        // it unnecessary, so its absence is the regression guard.
        textHalo: (() => {
          const body = document.querySelector('.event-entry .event-body');
          return body ? getComputedStyle(body).textShadow : null;
        })(),
        zIndex: [before.zIndex, after.zIndex],
        loaded,
        viewport: [window.innerWidth, window.innerHeight],
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyOpaque: !['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(document.body).backgroundColor),
        rootHasColour: getComputedStyle(document.documentElement).backgroundColor !== 'rgba(0, 0, 0, 0)',
      };
    })()`);
    if (!background.image.includes('background.jpg')) throw new Error(`${viewport.name}: the background image is not applied ${JSON.stringify(background)}`);
    if (background.size !== 'cover') throw new Error(`${viewport.name}: the background is ${background.size} instead of cover`);
    if (background.position !== 'fixed') throw new Error(`${viewport.name}: the background layer is ${background.position}, so cover-cropping would scroll away`);
    if (!background.loaded.ok || background.loaded.width < 1000) throw new Error(`${viewport.name}: the background image did not load ${JSON.stringify(background.loaded)}`);
    if (!background.scrim.content || background.scrim.content === 'none') throw new Error(`${viewport.name}: the whole-page scrim is missing, the photo needs a readable backdrop`);
    if (background.scrim.mixBlendMode !== 'normal') throw new Error(`${viewport.name}: the veil uses mix-blend-mode ${background.scrim.mixBlendMode}, the simple design has none`);
    if (String(background.scrim.maskImage) !== 'none') throw new Error(`${viewport.name}: the veil carries a mask (${background.scrim.maskImage}), the simple design has none`);
    if (background.scrim.zIndex !== '-1') throw new Error(`${viewport.name}: the scrim sits at z-index ${background.scrim.zIndex}, it must stay above the photo layer's -2`);
    if (background.scrim.pointerEvents !== 'none') throw new Error(`${viewport.name}: the scrim swallows pointer events`);
    if (!background.floor) throw new Error(`${viewport.name}: --bg-scrim-veil is not defined, the lift has no tunable strength`);
    // The user asked for no wash behind the text either: entries must be transparent and
    // the text must carry its own contrast through glyph outlining.
    const opaque = (background.surfaces ?? []).filter((surface) => surface && surface.background !== 'rgba(0, 0, 0, 0)');
    if (opaque.length) throw new Error(`${viewport.name}: a text surface is still tinted ${JSON.stringify(opaque)}`);
    if (background.textHalo && background.textHalo !== 'none') throw new Error(`${viewport.name}: text carries a halo (${background.textHalo}), which blurs every glyph edge`);
    if (background.overflow > 0) throw new Error(`${viewport.name}: the background pushed the page sideways`);
    // The photo layer has a negative z-index, so an opaque body background silently
    // covers it: this exact regression made the background look unchanged.
    if (background.bodyOpaque) throw new Error(`${viewport.name}: body paints ${background.bodyBackground}, which hides the background photo`);
    if (!background.rootHasColour) throw new Error(`${viewport.name}: the canvas colour is missing, the area outside the photo would flash white`);
    console.log(`${viewport.name} background: ${JSON.stringify(background)}`);
    // --- 抽屉里的深搜：按对话内容找会话，而不是只匹配标题 ---
    const deepSearch = await (async () => {
      await cdp.evaluate(`(() => {
        const drawer = document.querySelector('#agent-drawer');
        if (!drawer.classList.contains('open')) document.querySelector('#drawer-toggle').click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#drawer-query');
        input.value = 'beta-history-699';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const deadline = Date.now() + 15_000;
      let hits = 0;
      while (Date.now() < deadline) {
        hits = await cdp.evaluate("document.querySelectorAll('#drawer-deep-search .drawer-deep-hit').length");
        if (hits > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const snippet = await cdp.evaluate(`(() => {
        const row = document.querySelector('#drawer-deep-search .drawer-deep-hit');
        return row ? {
          title: row.querySelector('.drawer-deep-title')?.textContent.trim().slice(0, 60) ?? '',
          snippet: row.querySelector('.drawer-deep-snippet')?.textContent.trim() ?? '',
          session: row.dataset.deepSession ?? '',
          // 清空搜索框后这一行会被移除，所以圆角只能在这里量
          radius: parseFloat(getComputedStyle(row).borderTopLeftRadius) || 0,
        } : null;
      })()`);
      if (snippet) {
        await cdp.evaluate("document.querySelector('#drawer-deep-search .drawer-deep-hit').click()");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // The drawer still filters the tree by the query, so the opened conversation
      // is asserted from the conversation pane itself.
      const selected = await cdp.evaluate("document.querySelector('#session-title-heading').textContent.trim()");
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#drawer-query');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const closed = await cdp.evaluate("document.querySelector('#drawer-deep-search').hidden");
      return { hits, snippet, selected, hiddenWhenEmpty: closed };
    })();
    if (deepSearch.hits < 1) throw new Error(`${viewport.name}: searching message text found nothing (${JSON.stringify(deepSearch)})`);
    if (!deepSearch.snippet?.snippet.includes('beta-history-699')) throw new Error(`${viewport.name}: the hit does not show the matched text (${JSON.stringify(deepSearch.snippet)})`);
    if (deepSearch.selected !== "Beta review") throw new Error(`${viewport.name}: clicking a hit opened ${JSON.stringify(deepSearch.selected)} instead of that conversation`);
    if (!deepSearch.hiddenWhenEmpty) throw new Error(`${viewport.name}: clearing the query left the search results on screen`);
    console.log(`${viewport.name} deep search: ${JSON.stringify({ hits: deepSearch.hits, snippet: deepSearch.snippet.snippet.slice(0, 40) })}`);

    // --- 顶栏一行 + 折叠按钮钉在左上角 ---
    const chrome = await cdp.evaluate(`(() => {
      const bar = document.querySelector('.topbar');
      const brand = document.querySelector('.brand');
      const connection = document.querySelector('#connection-status');
      const toggle = document.querySelector('#drawer-toggle');
      const rectOf = (element) => element.getBoundingClientRect();
      const barRect = rectOf(bar);
      const brandRect = rectOf(brand);
      const connectionRect = rectOf(connection);
      const toggleRect = rectOf(toggle);
      const toggleVisible = getComputedStyle(toggle).display !== 'none';
      return {
        barHeight: Math.round(barRect.height),
        barTop: Math.round(barRect.top),
        // align-items:center means the centres line up, not the tops.
        brandCenter: Math.round(brandRect.top + brandRect.height / 2),
        connectionCenter: Math.round(connectionRect.top + connectionRect.height / 2),
        connectionFits: connectionRect.right <= window.innerWidth + 0.5,
        toggleVisible,
        toggleLeft: Math.round(toggleRect.left),
        toggleTop: Math.round(toggleRect.top),
        toggleHeight: Math.round(toggleRect.height),
        brandTextVisible: getComputedStyle(document.querySelector('.brand-text')).display !== 'none',
        connectionTextVisible: getComputedStyle(document.querySelector('#connection-status span:last-child')).display !== 'none',
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    if (chrome.barHeight > 56) throw new Error(`${viewport.name}: the top bar is ${chrome.barHeight}px tall (should be one row)`);
    if (Math.abs(chrome.brandCenter - chrome.connectionCenter) > 2) throw new Error(`${viewport.name}: the brand and the status are not on one row ${JSON.stringify(chrome)}`);
    if (!chrome.connectionFits || chrome.overflow > 0) throw new Error(`${viewport.name}: the top bar overflows ${JSON.stringify(chrome)}`);
    if (phone) {
      if (!chrome.toggleVisible) throw new Error(`${viewport.name}: the drawer toggle must be reachable on a phone`);
      if (chrome.toggleHeight < 44) throw new Error(`${viewport.name}: the drawer toggle is too small to tap (${chrome.toggleHeight}px)`);
      if (chrome.toggleLeft > 16 || Math.abs(chrome.toggleTop - chrome.barTop) > 8) {
        throw new Error(`${viewport.name}: the drawer toggle is not pinned to the top-left ${JSON.stringify(chrome)}`);
      }
      const togglePosition = await cdp.evaluate("getComputedStyle(document.querySelector('#drawer-toggle')).position");
      if (togglePosition !== "fixed") throw new Error(`${viewport.name}: the toggle is ${togglePosition}, so it cannot stay pinned while scrolling`);
    } else if (chrome.toggleVisible) {
      throw new Error(`${viewport.name}: the hamburger must stay hidden beside a permanent sidebar`);
    }
    console.log(`${viewport.name} chrome: ${JSON.stringify(chrome)}`);

    // --- 抽屉里的每一行 / 每一张卡片共用同一套样式 ---
    // 抽屉是三个不同来路的组件拼起来的（Agent 行、会话行、全局搜索命中行、通知卡片、
    // 底部两个按钮）。它们必须共用同一套圆角、同一套材质，否则一眼就能看出是拼的。
    const drawerStyle = await cdp.evaluate(`(() => {
      const drawer = document.querySelector('#agent-drawer');
      const style = (element) => (element ? getComputedStyle(element) : null);
      const radius = (selector) => {
        const element = document.querySelector(selector);
        return element ? parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0 : null;
      };
      const sheet = style(document.querySelector('#create-sheet'));
      const card = document.querySelector('#agent-drawer .drawer-card');
      const toggle = document.querySelector('#drawer-notify-toggle');
      // 没配 webhook 时通知卡片整体隐藏、开关也隐藏；量材质时临时显示再还原，
      // 否则"没配置通知"就会让这个组件的样式逃过审计。
      const previous = card ? [card.hidden, toggle.hidden] : [];
      if (card) { card.hidden = false; toggle.hidden = false; }
      const cardStyle = style(card);
      const toggleStyle = style(toggle);
      const reference = document.createElement('button');
      reference.className = 'secondary-button';
      reference.textContent = 'x';
      drawer.appendChild(reference);
      const referenceStyle = style(reference);
      // 读值必须在 remove 之前取成字符串：CSSStyleDeclaration 是活的，节点一移除就空了
      const referenceBackground = referenceStyle.backgroundColor;
      const referenceRing = referenceStyle.boxShadow;
      reference.remove();
      const cardRect = card ? card.getBoundingClientRect() : null;
      const overflow = cardRect ? Math.max(0, Math.round(cardRect.right - window.innerWidth), Math.round(drawer.getBoundingClientRect().left - cardRect.left)) : 0;
      const footer = document.querySelector('#agent-drawer .drawer-foot');
      const footerButtons = [...footer.querySelectorAll('.secondary-button')]
        .filter((button) => !button.hidden && getComputedStyle(button).display !== 'none');
      const footerWidths = footerButtons.map((button) => Math.round(button.getBoundingClientRect().width));
      const footerRow = Math.round(footer.getBoundingClientRect().width);
      // 只剩一个按钮时它必须吃满整行——否则右半边空着，看着像丢了东西
      const footerHidden = footerButtons.map((button) => button.hidden);
      footerButtons.slice(1).forEach((button) => { button.hidden = true; });
      const loneFooterWidth = footerButtons.length ? Math.round(footerButtons[0].getBoundingClientRect().width) : 0;
      footerButtons.forEach((button, index) => { button.hidden = footerHidden[index]; });
      const result = {
        agentRadius: radius('#drawer-tree .drawer-agent'),
        sessionRadius: radius('#drawer-tree .drawer-session'),
        cardRadius: cardStyle ? parseFloat(cardStyle.borderTopLeftRadius) || 0 : null,
        cardBorderWidth: cardStyle ? cardStyle.borderTopWidth : null,
        cardBorderColour: cardStyle ? cardStyle.borderTopColor : null,
        cardBlur: cardStyle ? (cardStyle.backdropFilter || cardStyle.webkitBackdropFilter) : null,
        cardShadow: cardStyle ? cardStyle.boxShadow : null,
        cardBackground: cardStyle ? cardStyle.backgroundColor : null,
        noteColour: cardStyle ? getComputedStyle(document.querySelector('#drawer-notify-note')).color : null,
        switchColour: toggleStyle ? toggleStyle.color : null,
        sheetBorderWidth: sheet.borderTopWidth,
        sheetBorderColour: sheet.borderTopColor,
        sheetBlur: sheet.backdropFilter || sheet.webkitBackdropFilter,
        cardOverflow: overflow,
        switchIsSecondary: toggle.classList.contains('secondary-button'),
        switchHeight: toggleStyle ? Math.round(toggle.getBoundingClientRect().height) : 0,
        switchBackground: toggleStyle ? toggleStyle.backgroundColor : null,
        switchRing: toggleStyle ? toggleStyle.boxShadow : null,
        referenceBackground,
        referenceRing,
        footerCount: footerWidths.length,
        footerWidths,
        footerRow,
        loneFooterWidth,
        // 抽屉的滚动容器不能横向溢出，否则卡片会被裁掉右边的圆角
        drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
      };
      if (card) { card.hidden = previous[0]; toggle.hidden = previous[1]; }
      return result;
    })()`);
    const radii = [drawerStyle.agentRadius, drawerStyle.sessionRadius, deepSearch.snippet?.radius];
    if (radii.some((value) => !value)) throw new Error(`${viewport.name}: a drawer row is missing its radius ${JSON.stringify(drawerStyle)}`);
    if (new Set(radii).size !== 1) throw new Error(`${viewport.name}: drawer rows use different radii ${JSON.stringify(radii)}`);
    if (drawerStyle.cardRadius !== 20) throw new Error(`${viewport.name}: the notification card is ${drawerStyle.cardRadius}px round, the shared material is 20px`);
    if (drawerStyle.cardBorderWidth !== drawerStyle.sheetBorderWidth || drawerStyle.cardBorderColour !== drawerStyle.sheetBorderColour) {
      throw new Error(`${viewport.name}: the notification card border ${drawerStyle.cardBorderWidth} ${drawerStyle.cardBorderColour} does not match the sheet ${drawerStyle.sheetBorderWidth} ${drawerStyle.sheetBorderColour}`);
    }
    if (drawerStyle.cardBlur !== drawerStyle.sheetBlur) throw new Error(`${viewport.name}: the notification card blurs with ${drawerStyle.cardBlur}, the sheet with ${drawerStyle.sheetBlur}`);
    if (!drawerStyle.cardShadow || drawerStyle.cardShadow === "none") throw new Error(`${viewport.name}: the notification card has no shadow, it floats on the photo untethered`);
    if (drawerStyle.cardOverflow > 0 || drawerStyle.drawerOverflow > 0) throw new Error(`${viewport.name}: the drawer overflows sideways ${JSON.stringify({ card: drawerStyle.cardOverflow, drawer: drawerStyle.drawerOverflow })}`);
    if (!drawerStyle.switchIsSecondary) throw new Error(`${viewport.name}: the notification switch is not the shared secondary button`);
    if (drawerStyle.switchHeight < 40) throw new Error(`${viewport.name}: the notification switch is ${drawerStyle.switchHeight}px tall, too short to tap`);
    if (drawerStyle.switchBackground !== drawerStyle.referenceBackground) throw new Error(`${viewport.name}: the notification switch paints ${drawerStyle.switchBackground} instead of the button's ${drawerStyle.referenceBackground}`);
    if (drawerStyle.switchRing !== drawerStyle.referenceRing) throw new Error(`${viewport.name}: the notification switch ring differs from every other secondary button`);
    if (drawerStyle.footerCount === 1 && Math.abs(drawerStyle.footerWidths[0] - drawerStyle.footerRow) > 1) {
      throw new Error(`${viewport.name}: the lone footer button leaves a half-empty row (${drawerStyle.footerWidths[0]} of ${drawerStyle.footerRow}px)`);
    }
    if (drawerStyle.footerCount > 1 && Math.abs(drawerStyle.footerWidths[0] - drawerStyle.footerWidths[1]) > 1) {
      throw new Error(`${viewport.name}: the footer buttons are different widths ${JSON.stringify(drawerStyle.footerWidths)}`);
    }
    if (drawerStyle.footerCount && Math.abs(drawerStyle.loneFooterWidth - drawerStyle.footerRow) > 1) {
      throw new Error(`${viewport.name}: hiding one footer button leaves the other at ${drawerStyle.loneFooterWidth} of ${drawerStyle.footerRow}px`);
    }
    console.log(`${viewport.name} drawer style: ${JSON.stringify({ radii, cardRadius: drawerStyle.cardRadius, cardBlur: drawerStyle.cardBlur, cardBackground: drawerStyle.cardBackground, cardBorder: drawerStyle.cardBorderWidth + " " + drawerStyle.cardBorderColour, noteColour: drawerStyle.noteColour, switchBackground: drawerStyle.switchBackground, footerWidths: drawerStyle.footerWidths })}`);

    // --- 选择会话：抽屉收起（手机）、会话头随之切换 ---
    await waitFor(cdp, `document.querySelectorAll('#drawer-tree [data-session]').length >= ${shell.sessions}`, `${viewport.name} session rows`);
    if (shell.sessions < 3) throw new Error(`${viewport.name}: expected the fixture conversations under echo, saw ${shell.sessions}`);
    const targetSession = await cdp.evaluate("document.querySelector('#drawer-tree [data-session]').dataset.session");
    await cdp.evaluate("document.querySelector('#drawer-tree [data-session]').click()");
    await waitFor(cdp, `document.querySelector('#session-title-heading').textContent.length > 0`, `${viewport.name} selected session header`);
    const selected = await cdp.evaluate(`(() => ({
      heading: document.querySelector('#session-title-heading').textContent,
      drawerOpen: document.querySelector('#agent-drawer').classList.contains('open'),
      current: document.querySelectorAll('#drawer-tree [data-session][aria-current="true"]').length,
    }))()`);
    if (phone && selected.drawerOpen) throw new Error(`${viewport.name}: picking a conversation must close the overlay`);
    if (!phone && !selected.drawerOpen) throw new Error(`${viewport.name}: the sidebar must stay open`);
    if (selected.current !== 1) throw new Error(`${viewport.name}: the selected conversation is not marked current`);
    console.log(`${viewport.name} nav: ${JSON.stringify({ ...shell, selected: { ...selected, sessionId: targetSession } })}`);

    // --- 新建会话：抽屉头部 ＋ → 底部抽屉 → 真正提交 ---
    // A per-viewport title keeps the wait honest: the desktop pass already created
    // one conversation, and a shared title would let the check resolve before the
    // submit it is supposed to observe.
    const createdTitle = `DRAWER-VERIFY-${viewport.name}`;
    const before = await cdp.evaluate("document.querySelectorAll('#drawer-tree [data-session]').length");
    await cdp.evaluate("document.querySelector('#drawer-create').click()");
    await waitFor(cdp, "document.querySelector('#create-sheet').classList.contains('open')", `${viewport.name} create sheet`);
    // The sheet slides up from the bottom edge; measure it after the transition.
    await new Promise((resolve) => setTimeout(resolve, 320));
    const sheet = await cdp.evaluate(`(() => ({
      fits: document.querySelector('#create-sheet').getBoundingClientRect().bottom <= innerHeight + 1,
      adapterOptions: [...document.querySelectorAll('#create-adapter option')].map((option) => [option.value, option.disabled]),
      projects: [...document.querySelectorAll('#create-project option')].map((option) => option.value),
      enabled: !document.querySelector('#create-form button[type=submit]').disabled,
    }))()`);
    if (!sheet.fits || !sheet.enabled) throw new Error(`${viewport.name}: the create sheet is not usable ${JSON.stringify(sheet)}`);
    if (!sheet.projects.includes("alpha")) throw new Error(`${viewport.name}: registered projects are missing from the create sheet`);
    await cdp.evaluate(`(() => {
      const form = document.querySelector('#create-form');
      form.querySelector('#create-project').value = 'alpha';
      form.querySelector('#create-title-input').value = ${JSON.stringify(createdTitle)};
      form.requestSubmit();
      return true;
    })()`);
    await waitFor(cdp, `document.querySelectorAll('#drawer-tree [data-session]').length > ${before}`, `${viewport.name} created conversation`);
    const afterCreate = await cdp.evaluate(`(() => ({
      heading: document.querySelector('#session-title-heading').textContent,
      sheetOpen: document.querySelector('#create-sheet').classList.contains('open'),
      titles: [...document.querySelectorAll('#drawer-tree .drawer-session-title')].map((el) => el.textContent),
    }))()`);
    if (afterCreate.heading !== createdTitle) throw new Error(`${viewport.name}: the new conversation was not selected (${afterCreate.heading})`);
    if (afterCreate.sheetOpen) throw new Error(`${viewport.name}: the create sheet stayed open`);
    console.log(`${viewport.name} create: ${JSON.stringify(afterCreate)}`);
    // --- 加载更早：单会话超过一页时出现，翻页后条目变多且滚动位置保持 ---
    await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#drawer-tree [data-session]')];
      const beta = rows.find((row) => row.textContent.includes('Beta review'));
      beta?.click();
      return Boolean(beta);
    })()`);
    await waitFor(cdp, "document.querySelector('#session-title-heading').textContent === 'Beta review'", `${viewport.name} beta conversation`);
    await waitFor(cdp, "!document.querySelector('#history-more').hidden", `${viewport.name} load-earlier control`);
    const beforePaging = await cdp.evaluate(`(() => {
      const log = document.querySelector('#event-log');
      log.scrollTop = 120;
      return { entries: log.querySelectorAll('.event-entry').length, scrollTop: log.scrollTop, label: document.querySelector('#load-earlier span').textContent };
    })()`);
    await cdp.evaluate("document.querySelector('#load-earlier').click()");
    await waitFor(cdp, `document.querySelectorAll('#event-log .event-entry').length > ${beforePaging.entries}`, `${viewport.name} earlier page`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterPaging = await cdp.evaluate(`(() => {
      const log = document.querySelector('#event-log');
      return { entries: log.querySelectorAll('.event-entry').length, scrollTop: log.scrollTop, stillVisible: !document.querySelector('#history-more').hidden };
    })()`);
    if (beforePaging.label !== "加载更早") throw new Error(`${viewport.name}: unexpected paging label ${beforePaging.label}`);
    if (afterPaging.entries <= beforePaging.entries) throw new Error(`${viewport.name}: the earlier page added nothing`);
    if (!afterPaging.stillVisible) throw new Error(`${viewport.name}: the control disappeared with more history available`);

    // --- 加载更早的尺寸：它是一条按钮，不是一块背景 ---
    // 这个可选子元素一出现就会顶替自动放置的 1fr 行，把加载条撑成 320px 的巨型胶囊，
    // 同时把日志挤去 auto 行。行号钉死之后这里必须一直是一行按钮那么高。
    const pagingBox = await cdp.evaluate(`(() => {
      const bar = document.querySelector('#history-more');
      const button = document.querySelector('#load-earlier');
      const log = document.querySelector('#event-log');
      const view = document.querySelector('#session-view');
      const measure = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { height: Math.round(rect.height), width: Math.round(rect.width), row: style.gridRowStart, align: style.alignItems };
      };
      return { viewRows: getComputedStyle(view).gridTemplateRows, bar: measure(bar), button: measure(button), log: measure(log) };
    })()`);
    if (pagingBox.bar.height > 60) throw new Error(`${viewport.name}: the load-earlier bar is ${pagingBox.bar.height}px tall (should be one button row): ${JSON.stringify(pagingBox)}`);
    if (pagingBox.button.height < 30 || pagingBox.button.height > 48) throw new Error(`${viewport.name}: the load-earlier button is ${pagingBox.button.height}px tall: ${JSON.stringify(pagingBox)}`);
    if (pagingBox.button.width > 240) throw new Error(`${viewport.name}: the load-earlier button is ${pagingBox.button.width}px wide: ${JSON.stringify(pagingBox)}`);
    if (pagingBox.bar.row !== "2") throw new Error(`${viewport.name}: the load-earlier bar landed in grid row ${pagingBox.bar.row}, not the auto row above the transcript`);
    if (pagingBox.log.row !== "3") throw new Error(`${viewport.name}: the transcript landed in grid row ${pagingBox.log.row}, so it lost the 1fr row`);
    if (pagingBox.log.height < 300) throw new Error(`${viewport.name}: the transcript is only ${pagingBox.log.height}px tall next to the paging bar`);
    console.log(`${viewport.name} paging box: ${JSON.stringify(pagingBox)}`);
    console.log(`${viewport.name} paging: ${JSON.stringify({ beforePaging, afterPaging })}`);
    if (phone) {
      // The page is genuinely long now (700 events), so this is a real scroll.
      await cdp.evaluate("window.scrollTo(0, 900)");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const pinned = await cdp.evaluate(`(() => {
        const rect = document.querySelector('#drawer-toggle').getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left), visible: rect.top >= 0 && rect.bottom <= window.innerHeight, scrolledBy: Math.round(window.scrollY) };
      })()`);
      if (pinned.scrolledBy < 200) throw new Error(`${viewport.name}: the page did not scroll, so pinning is untested ${JSON.stringify(pinned)}`);
      if (!pinned.visible || pinned.top > 16) throw new Error(`${viewport.name}: the toggle scrolled away ${JSON.stringify(pinned)}`);
      await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
      await waitFor(cdp, "document.querySelector('#agent-drawer').classList.contains('open')", `${viewport.name} drawer from a scrolled page`);
      const hiddenWhileOpen = await cdp.evaluate("getComputedStyle(document.querySelector('#drawer-toggle')).opacity");
      if (Number(hiddenWhileOpen) > 0.05) throw new Error(`${viewport.name}: the toggle stayed visible over the open drawer`);
      await cdp.evaluate("document.querySelector('#drawer-close').click()");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await cdp.evaluate("window.scrollTo(0, 0)");
      console.log(`${viewport.name} pinned toggle after scrolling ${pinned.scrolledBy}px: ${JSON.stringify(pinned)}`);
    }

    // --- 历史同步按钮只在本机确实有可发现能力的 Agent 时出现 ---
    const catalog = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
    const discoverableIds = catalog.adapters
      .filter((adapter) => adapter.capabilities?.discover === true && adapter.availability?.available === true && adapter.availability?.supported !== false)
      .map((adapter) => adapter.id);
    const hasDiscoverable = catalog.adapters.some((adapter) => (
      adapter.capabilities?.discover === true && adapter.availability?.available === true && adapter.availability?.supported !== false
    ));
    const sync = await cdp.evaluate(`(() => ({
      hidden: document.querySelector('#drawer-discover').hidden,
      refreshEnabled: !document.querySelector('#drawer-refresh').disabled,
    }))()`);
    if (sync.hidden === hasDiscoverable) {
      throw new Error(`${viewport.name}: drawer footer state is wrong (discoverable=${hasDiscoverable}) ${JSON.stringify(sync)}`);
    }
    if (!sync.refreshEnabled) throw new Error(`${viewport.name}: 刷新状态 must always be available`);

    if (hasDiscoverable) {
      // 同步历史 asks which Agent and which project instead of picking for the user.
      if (phone && !(await cdp.evaluate("document.querySelector('#agent-drawer').classList.contains('open')"))) {
        await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await cdp.evaluate("document.querySelector('#drawer-discover').click()");
      await waitFor(cdp, "document.querySelector('#sync-sheet').classList.contains('open')", `${viewport.name} sync sheet`);
      await new Promise((resolve) => setTimeout(resolve, 320));
      const syncSheet = await cdp.evaluate(`(() => {
        const discoverable = new Set(${JSON.stringify(discoverableIds)});
        return {
          adapters: [...document.querySelectorAll('#sync-adapter option')].map((option) => option.value),
          projects: [...document.querySelectorAll('#sync-project option')].map((option) => option.value),
          selectedProject: document.querySelector('#sync-project').value,
          note: document.querySelector('#sync-adapter-note').textContent,
          fits: document.querySelector('#sync-sheet').getBoundingClientRect().bottom <= innerHeight + 1,
          drawerClosed: !document.querySelector('#agent-drawer').classList.contains('open') || !${phone},
        };
      })()`);
      const expectedAdapters = [...discoverableIds].sort();
      if (JSON.stringify([...syncSheet.adapters].sort()) !== JSON.stringify(expectedAdapters)) {
        throw new Error(`${viewport.name}: the sync sheet listed the wrong Agents ${JSON.stringify(syncSheet)}`);
      }
      if (!syncSheet.projects.includes(alphaWorkspace.id) || !syncSheet.projects.includes(betaWorkspace.id)) {
        throw new Error(`${viewport.name}: the sync sheet is missing projects ${JSON.stringify(syncSheet)}`);
      }
      if (!syncSheet.fits || !syncSheet.note.includes("不会启动对话")) {
        throw new Error(`${viewport.name}: the sync sheet is not usable ${JSON.stringify(syncSheet)}`);
      }
      await cdp.evaluate("document.querySelector('#sync-close').click()");
      await new Promise((resolve) => setTimeout(resolve, 320));
      if (!(await cdp.evaluate("!document.querySelector('#sync-sheet').classList.contains('open')"))) {
        throw new Error(`${viewport.name}: the sync sheet did not close`);
      }
      console.log(`${viewport.name} sync sheet: ${JSON.stringify(syncSheet)}`);
    }

    const overflow = await cdp.evaluate("document.documentElement.scrollWidth - window.innerWidth");
    if (overflow > 0) throw new Error(`${viewport.name}: the page scrolls sideways by ${overflow}px`);

    if (SCREENSHOT_DIR) {
      if (phone && !(await cdp.evaluate("document.querySelector('#agent-drawer').classList.contains('open')"))) {
        await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      await writeFile(path.join(SCREENSHOT_DIR, `agentbridge-drawer-${viewport.name}.png`), Buffer.from(screenshot.data, "base64"));
    }
  }  // 极窄屏：三者仍在一行，文字降级但按钮不缩小、不横向溢出。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await waitFor(cdp, "document.querySelectorAll('#drawer-tree .drawer-agent').length > 0", "narrow drawer tree");
  const narrow = await cdp.evaluate(`(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const toggle = document.querySelector('#drawer-toggle').getBoundingClientRect();
    return {
      barHeight: Math.round(bar.height),
      barRight: Math.round(bar.right),
      brandTextHidden: getComputedStyle(document.querySelector('.brand-text')).display === 'none',
      connectionTextHidden: getComputedStyle(document.querySelector('#connection-status span:last-child')).display === 'none',
      toggleSize: [Math.round(toggle.width), Math.round(toggle.height)],
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      viewportWidth: window.innerWidth,
    };
  })()`);
  if (narrow.barHeight > 56) throw new Error(`320px: the top bar wrapped (${narrow.barHeight}px)`);
  if (!narrow.brandTextHidden || !narrow.connectionTextHidden) throw new Error(`320px: the compact top bar did not degrade ${JSON.stringify(narrow)}`);
  if (narrow.toggleSize[0] < 44 || narrow.toggleSize[1] < 44) throw new Error(`320px: the toggle shrank ${JSON.stringify(narrow)}`);
  if (narrow.overflow > 0) throw new Error(`320px: the page scrolls sideways by ${narrow.overflow}px`);
  const narrowBackground = await cdp.evaluate(`(() => {
    const before = getComputedStyle(document.body, '::before');
    return { image: before.backgroundImage, size: before.backgroundSize, position: before.position };
  })()`);
  if (!narrowBackground.image.includes('background.jpg') || narrowBackground.size !== 'cover') {
    throw new Error(`320px: the background is not cover-cropped ${JSON.stringify(narrowBackground)}`);
  }
  console.log(`narrow 320px: ${JSON.stringify(narrow)}`);
  // 极窄屏上通知卡片还得装得下：抽屉宽度不够时，卡片要么换行要么省略号，不能撑破
  await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
  await waitFor(cdp, "document.querySelector('#agent-drawer').classList.contains('open')", "320px drawer open");
  const narrowDrawer = await cdp.evaluate(`(() => {
    const drawer = document.querySelector('#agent-drawer');
    const card = drawer.querySelector('.drawer-card');
    const toggle = document.querySelector('#drawer-notify-toggle');
    const note = document.querySelector('#drawer-notify-note');
    const previous = [card.hidden, toggle.hidden];
    card.hidden = false;
    toggle.hidden = false;
    const cardRect = card.getBoundingClientRect();
    const drawerRect = drawer.getBoundingClientRect();
    const result = {
      cardFits: cardRect.left >= drawerRect.left - 0.5 && cardRect.right <= drawerRect.right + 0.5,
      cardWidth: Math.round(cardRect.width),
      drawerWidth: Math.round(drawerRect.width),
      toggleWidth: Math.round(toggle.getBoundingClientRect().width),
      // 省略号而不是溢出：长提示必须被截断（scrollWidth > clientWidth 说明真被截了）
      noteClipped: note.scrollWidth > note.clientWidth,
      noteOverflow: note.scrollWidth - note.clientWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
    card.hidden = previous[0];
    toggle.hidden = previous[1];
    return result;
  })()`);
  if (!narrowDrawer.cardFits || narrowDrawer.overflow > 0) {
    throw new Error(`320px: the notification card does not fit the drawer ${JSON.stringify(narrowDrawer)}`);
  }
  if (narrowDrawer.toggleWidth < 44) throw new Error(`320px: the notification switch is too small to tap (${narrowDrawer.toggleWidth}px)`);
  console.log(`narrow 320px drawer: ${JSON.stringify(narrowDrawer)}`);} finally {
  cdp?.close();
  browser.kill();
  bridge.server.closeAllConnections();
  await new Promise((resolve) => bridge.server.close(resolve));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
