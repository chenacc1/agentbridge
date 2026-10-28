import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createBridge } from "../src/server.js";

// The model control is the one place where "the Agent did not tell me" and "the
// Agent cannot do this" look identical on screen. This checks the difference in a
// real browser: a conversation whose Agent is offline must still show the control,
// disabled, with the reason — never disappear.

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9338);
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

const browserPath = await findBrowser();
if (!browserPath) throw new Error("Chrome or Edge was not found");

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-model-control-"));
const projectDirectory = path.join(directory, "模型验证");
const dataDirectory = path.join(directory, "data");
await mkdir(projectDirectory);
await mkdir(dataDirectory);

// Seed the catalog the way a restart leaves it: the conversation is known, its
// Agent is gone, and only the persisted directory can describe the model.
const now = new Date().toISOString();
const withDirectory = "bs_11111111-1111-4111-8111-111111111111";
const withoutDirectory = "bs_22222222-2222-4222-8222-222222222222";
await writeFile(path.join(dataDirectory, "bridge-sessions.json"), JSON.stringify({
  schemaVersion: 1,
  revision: 2,
  items: [
    {
      id: withDirectory,
      workspaceId: null,
      projectAlias: "models",
      adapterId: "deepseek-harness-desktop",
      providerConversationId: "dsh-known-session",
      title: "记得模型的那个会话",
      origin: "desktop-attached",
      lifecycle: "offline",
      resumable: true,
      attached: true,
      lastError: null,
      modelDirectory: {
        current: { provider: "ds", model: "ds-chat", reasoningEffort: "high" },
        routable: true,
        groups: [{
          id: "ds",
          name: "DeepSeek",
          models: [{
            id: "ds-chat",
            name: "DeepSeek Chat",
            // Reasoning efforts keep the second picker on screen: the layout bug this
            // fixture exists to catch is one picker covering the other.
            reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" },
          }],
        }],
        failures: [],
      },
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: withoutDirectory,
      workspaceId: null,
      projectAlias: "models",
      adapterId: "deepseek-harness-desktop",
      providerConversationId: "dsh-unknown-session",
      title: "从没上报过模型的会话",
      origin: "desktop-attached",
      lifecycle: "offline",
      resumable: true,
      attached: true,
      lastError: null,
      modelDirectory: null,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ],
}, null, 2), "utf8");

const bridge = await createBridge({
  config: {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: dataDirectory,
    projects: new Map([["models", projectDirectory]]),
    pairingTtlMs: 60_000,
    sessionTtlMs: 600_000,
    machineName: "Model control verification",
  },
});
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const sessionToken = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));

const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-model-cdp-"));
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
    if (await cdp.evaluate("document.querySelectorAll('#drawer-tree .drawer-agent').length > 0 && document.readyState === 'complete'")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cdp.evaluate("document.querySelector('#desktop-pairing')?.setAttribute('hidden',''); document.querySelector('#return-entry')?.setAttribute('hidden','')");

  const openConversation = async (sessionId) => {
    await cdp.evaluate(`(() => {
      const agent = document.querySelector('#drawer-tree .drawer-agent[data-agent="deepseek-harness-desktop"]');
      if (agent && agent.getAttribute('aria-expanded') !== 'true') agent.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const clicked = await cdp.evaluate(`(() => {
      const row = document.querySelector('#drawer-tree [data-session="${sessionId}"]');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`the drawer does not list ${sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    return cdp.evaluate(`(() => ({
      heading: document.querySelector('#session-title-heading').textContent.trim(),
      status: document.querySelector('#control-status').textContent.trim(),
      hidden: document.querySelector('#model-control').hidden,
      display: getComputedStyle(document.querySelector('#model-control')).display,
      label: document.querySelector('#model-label').textContent.trim(),
      options: document.querySelector('#model-select').options.length,
      selected: document.querySelector('#model-select').selectedOptions[0]?.textContent.trim() ?? "",
      selectDisabled: document.querySelector('#model-select').disabled,
      applyDisabled: document.querySelector('#apply-model').disabled,
      note: document.querySelector('#model-note').textContent.trim(),
    }))()`);
  };

  const remembered = await openConversation(withDirectory);
  if (remembered.hidden || remembered.display === "none") problems.push("the model control is hidden for an offline conversation that does remember its model");
  if (!remembered.selectDisabled || !remembered.applyDisabled) problems.push(`an offline conversation can still change models ${JSON.stringify(remembered)}`);
  if (remembered.options < 1) problems.push("the persisted model directory did not reach the phone's model list");
  if (!remembered.selected.includes("DeepSeek Chat")) problems.push(`the persisted model was not preselected ${JSON.stringify(remembered.selected)}`);
  if (!/离线|\/phone/.test(remembered.note)) problems.push(`the note does not explain why the control is locked: ${JSON.stringify(remembered.note)}`);

  const unknown = await openConversation(withoutDirectory);
  if (unknown.hidden || unknown.display === "none") problems.push("the model control vanished when the Agent had not reported a directory");
  if (!unknown.selectDisabled) problems.push("a conversation without a directory can still change models");
  if (!/没有上报|离线/.test(unknown.note)) problems.push(`the note does not explain the missing directory: ${JSON.stringify(unknown.note)}`);

  // --- 组件风格：弹层与选择器必须沿用全站那一套玻璃配方 ---
  // The complaint this guards against: a native <select> popup and raw radio dots inside
  // a panel with its own border/shadow, so both components looked foreign. The assertion
  // is equality with .create-sheet — the app's existing "opens on click" surface — not a
  // hard-coded value, so the two can only drift together.
  const styleAudit = await cdp.evaluate(`(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        blur: style.backdropFilter || style.webkitBackdropFilter,
        halo: getComputedStyle(el, '::after').content,
        rim: getComputedStyle(el, '::before').boxShadow,
      };
    };
    const nativeSelect = getComputedStyle(document.querySelector('#model-select'));
    const radio = document.querySelector('input[name="auto-approve-minutes"]');
    const radioStyle = getComputedStyle(radio);
    const picker = read('#model-panel');
    const autoPanel = read('#auto-approve-panel');
    const sheet = read('#create-sheet');
    // Interaction audit on the auto-approve panel: its toggle is always usable when the
    // Agent supports approvals, while the model picker is disabled for offline sessions.
    const toggle = document.querySelector('#auto-approve-toggle');
    const autoEl = document.querySelector('#auto-approve-panel');
    toggle.click();
    const opened = !autoEl.hidden && toggle.getAttribute('aria-expanded') === 'true';
    const segmented = Boolean(document.querySelector('.segmented .segment span'));
    const switchControl = Boolean(document.querySelector('.switch .switch-track'));
    const primaryButton = document.querySelector('#auto-approve-arm')?.className ?? '';
    document.body.click();
    return {
      picker, autoPanel, sheet,
      opened,
      closedOnOutsideClick: autoEl.hidden && toggle.getAttribute('aria-expanded') === 'false',
      segmented,
      switchControl,
      primaryButton,
      nativeSelectHidden: nativeSelect.position === 'absolute' && nativeSelect.opacity === '0',
      radioHidden: radioStyle.position === 'absolute' && radioStyle.opacity === '0',
    };
  })()`);
  const same = (a, b, label) => {
    if (!a || !b) { problems.push(`style audit could not read ${label}`); return; }
    if (a.borderWidth !== b.borderWidth) problems.push(`${label} border ${a.borderWidth} differs from the sheet's ${b.borderWidth}`);
    if (a.borderColor !== b.borderColor) problems.push(`${label} border colour ${a.borderColor} differs from the sheet's ${b.borderColor}`);
    if (a.blur !== b.blur) problems.push(`${label} blur ${a.blur} differs from the sheet's ${b.blur}`);
  };
  same(styleAudit.picker, styleAudit.sheet, "the model picker popover");
  same(styleAudit.autoPanel, styleAudit.sheet, "the auto-approve popover");
  for (const [name, panel] of [["model picker", styleAudit.picker], ["auto-approve panel", styleAudit.autoPanel]]) {
    if (!panel || panel.radius !== "20px") problems.push(`${name} radius ${panel?.radius} is not the popover 20px`);
    if (!panel || panel.halo === "none" || !panel.halo) problems.push(`${name} is missing the shared top halo band`);
    if (!panel || !String(panel.rim).includes("inset")) problems.push(`${name} is missing the shared rim light`);
  }
  if (!styleAudit.nativeSelectHidden) problems.push("the native select is still visible, so its OS popup can still appear");
  if (!styleAudit.radioHidden) problems.push("the auto-approve panel still shows native radio dots");
  if (!styleAudit.segmented || !styleAudit.switchControl) problems.push("the auto-approve panel lacks the segmented/switch controls");
  if (!String(styleAudit.primaryButton).includes("primary-button")) problems.push("the confirm button is not the shared primary button");
  if (!styleAudit.opened) problems.push("the auto-approve panel does not open");
  if (!styleAudit.closedOnOutsideClick) problems.push("clicking outside did not close the panel");
  console.log(`style audit: ${JSON.stringify(styleAudit)}`);
  // --- 弹层必须落在手机框内（用户报过：面板一半溢出屏幕） ---
  const geometry = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Page.navigate", { url: `${origin}/` });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#auto-approve-toggle'))")) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // This loopback fixture also renders the desktop pairing card and the return strip;
    // hiding them puts the session header back where a paired phone sees it.
    await cdp.evaluate(`(() => {
      document.querySelector('#desktop-pairing')?.setAttribute('hidden', '');
      document.querySelector('#return-entry')?.setAttribute('hidden', '');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const measured = await cdp.evaluate(`(async () => {
      const toggle = document.querySelector('#auto-approve-toggle');
      const panel = document.querySelector('#auto-approve-panel');
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      return {
        open: !panel.hidden,
        position: style.position,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        viewportWidth,
        viewportHeight,
        withinX: rect.left >= 0 && rect.right <= viewportWidth + 0.5,
        withinY: rect.top >= 0 && rect.bottom <= viewportHeight + 0.5,
      };
    })()`);
    if (!measured.open) problems.push(`${viewport.width}px: the auto-approve panel did not open`);
    if (measured.position !== "fixed") problems.push(`${viewport.width}px: the panel is ${measured.position}, so it can be clipped by its container`);
    if (!measured.withinX) problems.push(`${viewport.width}px: the panel spans ${measured.left}..${measured.right} in a ${measured.viewportWidth}px viewport`);
    if (!measured.withinY) problems.push(`${viewport.width}px: the panel spans ${measured.top}..${measured.bottom} in a ${measured.viewportHeight}px viewport`);
    geometry.push(measured);
  }
  console.log(`popover geometry: ${JSON.stringify(geometry)}`);

  // --- 模型 / 推理强度控件必须装在自己的格子里（用户报过：模型名太长，控件互相压住） ---
  // 根因是 .picker 的隐式网格轨道用了 auto，下限是 min-content，长模型名会把轨道顶宽，
  // width:100% 的触发按钮跟着溢出并盖住右边的控件。这里把长名字塞进两个 value 再量几何。
  const LONG_MODEL = "DeepSeek · DeepSeek-V4-Flash-Vision-Exp";
  const LONG_EFFORT = "HighEffort";
  const controlGeometry = [];
  // 必须选中"记得模型"的那个会话：另一个会话没有目录，推理强度本来就该隐藏，
  // 在那上面量几何测不到"两个控件互压"。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await openConversation(withDirectory);
  for (const width of [320, 360, 390, 414, 480, 536, 780, 781, 1440]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 780 });
    await new Promise((resolve) => setTimeout(resolve, 320));
    const measured = await cdp.evaluate(`(() => {
      const modelValue = document.querySelector('#model-trigger-value');
      const effortValue = document.querySelector('#reasoning-trigger-value');
      if (modelValue) modelValue.textContent = ${JSON.stringify(LONG_MODEL)};
      if (effortValue) effortValue.textContent = ${JSON.stringify(LONG_EFFORT)};
      const pick = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: Math.round(rect.left), right: Math.round(rect.right),
          top: Math.round(rect.top), bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        };
      };
      const modelCell = pick('#model-picker');
      const reasoningCell = pick('#reasoning-control');
      const modelTrigger = pick('#model-trigger');
      const reasoningTrigger = pick('#reasoning-trigger');
      const applyButton = pick('#apply-model');
      const overlaps = [];
      const row = [
        ['model', modelCell], ['reasoning', reasoningCell], ['apply', applyButton],
      ].filter(([, box]) => box);
      for (let i = 0; i < row.length; i += 1) {
        for (let j = i + 1; j < row.length; j += 1) {
          const [aName, a] = row[i];
          const [bName, b] = row[j];
          const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          // Both axes must intersect: at ≤480px the model picker sits on its own row
          // directly above the reasoning picker, so they share the left edge by design.
          if (horizontal > 2 && vertical > 2) overlaps.push(aName + ">" + bName);
        }
      }
      const value = document.querySelector('#model-trigger-value');
      return {
        width: ${width},
        modelCell, modelTrigger, reasoningCell, reasoningTrigger, applyButton,
        overlaps,
        // 诊断：推理强度控件为什么可能不出现（离线夹具仍然要有它，才能测"两个控件互压"）
        reasoningHidden: document.querySelector('#reasoning-control')?.hidden ?? null,
        reasoningOptions: document.querySelector('#reasoning-select')?.options?.length ?? null,
        modelSelectValue: document.querySelector('#model-select')?.value ?? null,
        valueClipped: value ? { scrollWidth: value.scrollWidth, clientWidth: Math.round(value.getBoundingClientRect().width) } : null,
      };
    })()`);
    controlGeometry.push(measured);
    if (measured.modelTrigger && measured.modelCell) {
      if (measured.modelTrigger.width > measured.modelCell.width + 1) {
        problems.push(`${width}px: the model trigger is ${measured.modelTrigger.width}px wide in a ${measured.modelCell.width}px cell, so it covers its neighbour`);
      }
      if (measured.modelTrigger.scrollWidth > measured.modelTrigger.clientWidth + 1) {
        problems.push(`${width}px: the model trigger overflows (${measured.modelTrigger.scrollWidth} > ${measured.modelTrigger.clientWidth}) instead of ellipsizing`);
      }
    }
    if (measured.reasoningTrigger && measured.reasoningCell) {
      if (measured.reasoningTrigger.width > measured.reasoningCell.width + 1) {
        problems.push(`${width}px: the reasoning trigger is ${measured.reasoningTrigger.width}px wide in a ${measured.reasoningCell.width}px cell`);
      }
    }
    if (measured.overlaps.length) {
      problems.push(`${width}px: the model controls overlap: ${measured.overlaps.join(", ")}`);
    }
    if (measured.valueClipped && measured.valueClipped.scrollWidth > measured.valueClipped.clientWidth) {
      // 长名字必须真的被省略号截断，而不是把按钮撑开。
      const ellipsis = await cdp.evaluate("getComputedStyle(document.querySelector('#model-trigger-value')).textOverflow");
      if (ellipsis !== "ellipsis") problems.push(`${width}px: the truncated model name uses ${ellipsis} instead of an ellipsis`);
    }
  }
  console.log(`model control geometry: ${JSON.stringify(controlGeometry.map((entry) => ({
    width: entry.width,
    model: `${entry.modelTrigger?.width}in${entry.modelCell?.width}`,
    reasoning: `${entry.reasoningTrigger?.width}in${entry.reasoningCell?.width}`,
    reasoningHidden: entry.reasoningHidden,
    apply: entry.applyButton?.width,
    visibleChars: entry.valueClipped?.clientWidth,
    overlaps: entry.overlaps.length,
  })))}`);
  // 推理强度控件必须真的在场：否则这轮几何审计又退化成只测一个控件。
  if (controlGeometry.every((entry) => entry.reasoningHidden !== false)) {
    problems.push("the reasoning control never rendered, so the two-picker overlap audit measured nothing");
  }

  // 回到手机默认尺寸，后续断言沿用
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${origin}/` });
  await new Promise((resolve) => setTimeout(resolve, 800));

  // The create sheet has to say why DSH Desktop cannot open a conversation offline.
  await cdp.evaluate("document.querySelector('#drawer-toggle').click()");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await cdp.evaluate("document.querySelector('#drawer-create')?.click()");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const sheet = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('#create-adapter option')]
      .find((entry) => entry.value === 'deepseek-harness-desktop');
    return {
      open: !document.querySelector('#create-sheet')?.hidden,
      text: option?.textContent.trim() ?? "",
      disabled: option?.disabled ?? null,
    };
  })()`);
  await cdp.evaluate("document.querySelector('#create-adapter').value = 'deepseek-harness-desktop'; document.querySelector('#create-adapter').dispatchEvent(new Event('change', { bubbles: true }))");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sheetNote = await cdp.evaluate(`(() => ({
    note: document.querySelector('#create-adapter-note').textContent.trim(),
    submitDisabled: document.querySelector('#create-form button[type=submit]').disabled,
  }))()`);

  if (!sheet.open) problems.push("the create sheet did not open");
  if (!sheet.disabled) problems.push("DSH Desktop is offered as creatable while no companion is paired");
  if (!sheet.text.includes("桌面端离线")) problems.push(`the create sheet does not explain the offline desktop: ${JSON.stringify(sheet.text)}`);
  if (!/\/phone/.test(sheetNote.note)) problems.push(`the create sheet does not say how to fix it: ${JSON.stringify(sheetNote.note)}`);
  if (!sheetNote.submitDisabled) problems.push("the create sheet would submit for an Agent that cannot create");

  console.log(JSON.stringify({ remembered, unknown, sheet, sheetNote }));
  if (problems.length) {
    console.error("\nModel control verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("PASS  an offline Agent still shows the model control with the reason, and the create sheet names why it cannot create");
  }
} finally {
  cdp?.close();
  browser.kill();
  await bridge.server.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await rm(directory, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort.
  }
}
