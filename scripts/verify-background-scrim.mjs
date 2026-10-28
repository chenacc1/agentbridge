import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { createBridge } from "../src/server.js";

// The whole-page scrim is the only thing standing between the photo and readable
// text, so it is verified with pixels, not with opinions: every assertion below
// derives from a real screenshot of the real page.

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9337);
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

// Measures the composite (photo + scrim) from a screenshot the page itself decodes.
// `region` is the union of every rendered text box, so "worst case" means the
// darkest pixel that can actually sit behind a glyph.
const MEASURE = (base64, region) => `(async () => {
  const binary = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  const luminanceAt = (offset) => 0.2126 * linear(data[offset]) + 0.7152 * linear(data[offset + 1]) + 0.0722 * linear(data[offset + 2]);
  const box = ${JSON.stringify(region)};
  const x0 = Math.max(0, Math.round(box.x * width)), x1 = Math.min(width, Math.round((box.x + box.w) * width));
  const y0 = Math.max(0, Math.round(box.y * height)), y1 = Math.min(height, Math.round((box.y + box.h) * height));
  let floor = 1, peak = 0, sum = 0, count = 0;
  let chromaSum = 0, chromaCount = 0, detailSum = 0, detailCount = 0;
  for (let y = 0; y < height; y += 1) {
    let previous = null;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const L = luminanceAt(offset);
      chromaSum += Math.max(data[offset], data[offset + 1], data[offset + 2]) - Math.min(data[offset], data[offset + 1], data[offset + 2]);
      chromaCount += 1;
      if (previous !== null) { detailSum += Math.abs(L - previous); detailCount += 1; }
      previous = L;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        sum += L; count += 1;
        if (L < floor) floor = L;
        if (L > peak) peak = L;
      }
    }
  }
  bitmap.close();
  return {
    floor,
    peak,
    mean: sum / count,
    samples: count,
    chroma: chromaSum / chromaCount,
    detail: detailSum / detailCount * 1000,
  };
})()`;

const browserPath = await findBrowser();
if (!browserPath) throw new Error("Chrome or Edge was not found");

const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-scrim-"));
const projectDirectory = path.join(directory, "遮罩验证");
await mkdir(projectDirectory);
const bridge = await createBridge({
  config: {
    host: "127.0.0.1",
    port: 0,
    advertisedOrigin: "http://127.0.0.1:0",
    secureCookies: false,
    dataDir: path.join(directory, "data"),
    projects: new Map([["scrim", projectDirectory]]),
    pairingTtlMs: 60_000,
    sessionTtlMs: 600_000,
    machineName: "Scrim verification",
  },
});
const device = { id: "scrim-device", deviceName: "Verification" };
await bridge.sessions.create({ adapterId: "echo", projectAlias: "scrim", title: "占位会话", commandId: "scrim-decoy", device });
// The selected conversation: every text style that can land on the photo.
const session = await bridge.sessions.create({ adapterId: "echo", projectAlias: "scrim", title: "遮罩对比度验证会话", commandId: "scrim-main", device });
const append = (kind, payload) => bridge.eventStore.append(kind, payload, { sessionId: session.id });
await append("message.completed", { role: "user", text: "把遮罩参数按测量结果定下来，别凭感觉调。" });
await append("message.completed", {
  role: "assistant",
  text: [
    "**提亮地板**的做法：比地板亮的照片像素逐像素不动，比地板暗的抬到地板。",
    "",
    "- 正文 `#14141c`，次级文字 `#16191f`",
    "- 参数只有一个：`--bg-scrim-floor`",
    "",
    "参考 [对比度要求](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) 的 AA 门槛。",
  ].join("\n"),
});
await append("tool.started", { type: "shell", command: "npm run verify:scrim" });
await append("turn.failed", { error: "示例错误行：用于验证异常文字在遮罩地板上的对比度。" });
await append("message.completed", { role: "user", text: "再跑一次确认。" });
await append("message.completed", { role: "assistant", text: "已复核：地板与文字颜色配平后，正文、次级、用户与异常文字都在 4.5:1 以上。" });
await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.server.address().port}`;
const login = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const sessionToken = decodeURIComponent(login.headers.get("set-cookie").split(";", 1)[0].split("=").slice(1).join("="));

const profile = await mkdtemp(path.join(os.tmpdir(), "agentbridge-scrim-cdp-"));
const browser = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, dpr: 2, mobile: true },
  { name: "desktop", width: 1440, height: 1000, dpr: 1, mobile: false },
  { name: "narrow", width: 320, height: 568, dpr: 2, mobile: true },
];
// What the scrim did to the photo, pixel by pixel: how much of it is untouched,
// whether the touched part kept its texture, and whether the colour still matches.
// A flat "floor" colour scores well on contrast and terribly on the last two, which
// is exactly the regression this guards against.
const COMPARE = (current, bare) => `(async () => {
  const decode = async (data) => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  };
  const read = async (data) => {
    const bitmap = await decode(data);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return image;
  };
  const shot = await read(${JSON.stringify(current)});
  const plain = await read(${JSON.stringify(bare)});
  const { data, width, height } = shot;
  const base = plain.data;
  const linear = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (d, o) => 0.2126 * linear(d[o]) + 0.7152 * linear(d[o + 1]) + 0.0722 * linear(d[o + 2]);
  const hue = (r, g, b) => {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf), d = max - min;
    if (d < 1e-6) return 0;
    let h = max === rf ? 60 * (((gf - bf) / d) % 6) : max === gf ? 60 * (((bf - rf) / d) + 2) : 60 * (((rf - gf) / d) + 4);
    return h < 0 ? h + 360 : h;
  };
  let identical = 0, changed = 0, total = 0, clipped = 0;
  let detailShot = 0, detailBare = 0, detailCount = 0;
  let hueSum = 0, hueCount = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width - 2; x += 2) {
      const o = (y * width + x) * 4;
      const next = (y * width + x + 2) * 4;
      total += 1;
      const delta = Math.abs(data[o] - base[o]) + Math.abs(data[o + 1] - base[o + 1]) + Math.abs(data[o + 2] - base[o + 2]);
      if (delta <= 3) { identical += 1; continue; }
      changed += 1;
      if (data[o] >= 255 || data[o + 1] >= 255 || data[o + 2] >= 255) clipped += 1;
      detailShot += Math.abs(lum(data, next) - lum(data, o));
      detailBare += Math.abs(lum(base, next) - lum(base, o));
      detailCount += 1;
      const baseChroma = Math.max(base[o], base[o + 1], base[o + 2]) - Math.min(base[o], base[o + 1], base[o + 2]);
      if (baseChroma > 6) {
        let diff = Math.abs(hue(data[o], data[o + 1], data[o + 2]) - hue(base[o], base[o + 1], base[o + 2]));
        if (diff > 180) diff = 360 - diff;
        hueSum += diff;
        hueCount += 1;
      }
    }
  }
  return {
    untouched: identical / Math.max(1, total),
    detailKept: detailCount ? detailShot / Math.max(1e-6, detailBare) : null,
    hueShift: hueCount ? hueSum / hueCount : null,
    clipped: changed ? clipped / changed : 0,
  };
})()`;
const AA_SMALL = 4.5;
const AA_LARGE = 3;
const linear = (value) => {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};
const luminance = ([red, green, blue]) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
const contrastOf = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const parseColour = (value) => value.match(/[\d.]+/g).map(Number).slice(0, 3);

const problems = [];
const report = [];

let cdp;
try {
  cdp = await Cdp.attach(DEBUG_PORT);
  await cdp.openPage();
  await cdp.send("Network.setCookie", { name: "agentbridge_session", value: sessionToken, domain: "127.0.0.1", path: "/" });

  for (const viewport of VIEWPORTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: viewport.mobile,
    });
    await cdp.send("Page.navigate", { url: `${origin}/` });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate(`Boolean(document.querySelector('.event-entry .event-body')) && document.readyState === 'complete'`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // This loopback fixture also renders the desktop pairing card and the return
    // strip; both are opaque chrome, not the photo, so hide them before measuring.
    await cdp.evaluate(`(() => {
      document.querySelector('#desktop-pairing')?.setAttribute('hidden', '');
      document.querySelector('#return-entry')?.setAttribute('hidden', '');
      window.scrollTo(0, 0);
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // --- 1. The scrim is a real layer with the documented parameters ---
    const layers = await cdp.evaluate(`(async () => {
      const scrim = getComputedStyle(document.body, '::after');
      const photo = getComputedStyle(document.body, '::before');
      const loaded = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ ok: true, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ ok: false });
        image.src = '/background.jpg';
      });

      return {
        scrim: {
          content: scrim.content,
          mixBlendMode: scrim.mixBlendMode,
          background: scrim.backgroundColor,
          zIndex: scrim.zIndex,
          position: scrim.position,
          pointerEvents: scrim.pointerEvents,
          inset: [scrim.top, scrim.right, scrim.bottom, scrim.left],
        },
        veilVariable: getComputedStyle(document.documentElement).getPropertyValue('--bg-scrim-veil').trim(),
        floorVariable: getComputedStyle(document.documentElement).getPropertyValue('--bg-scrim-floor').trim(),
        photo: { image: photo.backgroundImage, size: photo.backgroundSize, position: photo.position, filter: photo.filter },
        loaded,
      };
    })()`);
    if (!layers.scrim.content || layers.scrim.content === "none") problems.push(`${viewport.name}: there is no page-wide scrim any more`);
    // The scrim is deliberately one plain white veil: no blend mode, no mask. What is
    // asserted here is that it really is a translucent white sheet (so the photo stays
    // visible) and that its alpha is in the measured band that keeps body text >= 6:1.
    if (layers.scrim.mixBlendMode !== "normal") problems.push(`${viewport.name}: the veil uses mix-blend-mode ${layers.scrim.mixBlendMode}, the simple design has none`);
    const veil = String(layers.scrim.background).match(/[\d.]+/g)?.map(Number) ?? [];
    const [veilR, veilG, veilB, veilA = 1] = veil;
    if (Math.abs(veilR - 255) > 1 || Math.abs(veilG - 255) > 1 || Math.abs(veilB - 255) > 1) problems.push(`${viewport.name}: the veil is not white (${layers.scrim.background})`);
    if (!(veilA >= 0.4 && veilA <= 0.75)) problems.push(`${viewport.name}: the veil alpha is ${veilA}, outside the measured 0.40–0.75 band`);
    if (!layers.veilVariable) problems.push(`${viewport.name}: --bg-scrim-veil is not defined, the veil has no tunable strength`);
    if (layers.scrim.zIndex !== "-1") problems.push(`${viewport.name}: the scrim sits at z-index ${layers.scrim.zIndex}, it must be -1 above the photo's -2`);
    if (layers.scrim.position !== "fixed") problems.push(`${viewport.name}: the scrim is ${layers.scrim.position}, it would scroll away from the photo`);
    if (layers.scrim.pointerEvents !== "none") problems.push(`${viewport.name}: the scrim swallows pointer events`);
    if (layers.scrim.inset.some((value) => value !== "0px")) problems.push(`${viewport.name}: the scrim does not cover the viewport ${JSON.stringify(layers.scrim.inset)}`);

    if (layers.photo.filter !== "none") problems.push(`${viewport.name}: the photo layer carries filter ${layers.photo.filter}, which softens it`);
    if (layers.photo.size !== "cover" || layers.photo.position !== "fixed") problems.push(`${viewport.name}: the photo layer is ${layers.photo.size}/${layers.photo.position}`);
    if (!layers.loaded.ok || layers.loaded.width < 1000) problems.push(`${viewport.name}: the photo did not load ${JSON.stringify(layers.loaded)}`);

    // --- 2. Every text box over the photo, and the region they occupy ---
    const textBoxes = await cdp.evaluate(`(() => {
      const selectors = ['.event-entry .event-body', '.event-time', '.session-header h2', '.session-meta', '#control-status', '.empty-state h2', '.empty-state p'];
      const boxes = [...document.querySelectorAll(selectors.join(','))]
        .filter((el) => el.offsetParent !== null && el.textContent.trim())
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const union = boxes.reduce((acc, rect) => ({
        left: Math.min(acc.left, rect.left), right: Math.max(acc.right, rect.right),
        top: Math.min(acc.top, rect.top), bottom: Math.max(acc.bottom, rect.bottom),
      }), { left: innerWidth, right: 0, top: innerHeight, bottom: 0 });
      return {
        count: boxes.length,
        region: {
          x: union.left / innerWidth,
          y: union.top / innerHeight,
          w: (union.right - union.left) / innerWidth,
          h: (union.bottom - union.top) / innerHeight,
        },
      };
    })()`);
    if (textBoxes.count < 3) problems.push(`${viewport.name}: only ${textBoxes.count} text boxes were found, the fixture is not rendering the transcript`);

    // --- 3. Real pixels: the floor under that region ---
    await cdp.evaluate(`(() => {
      let style = document.getElementById('scrim-probe-hide');
      if (!style) { style = document.createElement('style'); style.id = 'scrim-probe-hide'; document.head.append(style); }
      style.textContent = 'body *:not(style):not(link):not(script){visibility:hidden !important}';
      window.scrollTo(0, 0);
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const shippedShot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const shipped = await cdp.evaluate(MEASURE(shippedShot.data, textBoxes.region));

    await cdp.evaluate(`(() => {
      let style = document.getElementById('scrim-probe-off');
      if (!style) { style = document.createElement('style'); style.id = 'scrim-probe-off'; document.head.append(style); }
      style.textContent = 'body::after{content:none !important}';
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const bareShot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const bare = await cdp.evaluate(MEASURE(bareShot.data, textBoxes.region));
    const photoChange = await cdp.evaluate(COMPARE(shippedShot.data, bareShot.data));
    await cdp.evaluate("document.getElementById('scrim-probe-off').remove()");

    // --- 4. Every text colour that can land on the floor ---
    const colours = await cdp.evaluate(`(() => {
      const floorText = getComputedStyle(document.documentElement).getPropertyValue('--bg-scrim-floor').trim();
      const probe = document.createElement('div');
      probe.style.color = floorText;
      document.body.append(probe);
      const floorRgb = getComputedStyle(probe).color;
      probe.remove();
      const floor = floorRgb.match(/[\\d.]+/g).map(Number).slice(0, 3);
      const parse = (value) => value.match(/[\\d.]+/g).map(Number);
      const seen = new Map();
      const paintsOwnSurface = (style) => {
        const background = style.backgroundColor;
        const opaque = !/rgba\(0, 0, 0, 0\)|transparent/.test(background);
        return opaque || style.backgroundImage !== "none";
      };
      const elements = [...document.querySelectorAll('.conversation *')].filter((el) => {
        const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (!own || el.offsetParent === null) return false;
        // Visually hidden text is not read on screen, and a chip / code card paints
        // its own surface, so neither is measured against the photo floor.
        if (el.classList.contains('sr-only') || el.closest('.sr-only')) return false;
        return !paintsOwnSurface(getComputedStyle(el));
      });
      for (const el of elements) {
        const style = getComputedStyle(el);
        const [red, green, blue, alpha = 1] = parse(style.color);
        const mixed = [0, 1, 2].map((index) => Math.round([red, green, blue][index] * alpha + floor[index] * (1 - alpha)));
        const key = mixed.join(',');
        if (!seen.has(key)) {
          const weight = Number(style.fontWeight) || 400;
          const size = parseFloat(style.fontSize);
          seen.set(key, {
            colour: mixed.join(','),
            sample: el.className || el.tagName.toLowerCase(),
            text: el.textContent.trim().slice(0, 24),
            large: size >= 24 || (size >= 18.66 && weight >= 700),
          });
        }
      }
      return { floor, entries: [...seen.values()] };
    })()`);

    const floorLuminance = luminance(colours.floor);
    const worst = colours.entries
      .map((entry) => {
        const ratio = contrastOf(luminance(entry.colour.split(",").map(Number)), floorLuminance);
        return { ...entry, ratio: Number(ratio.toFixed(2)), threshold: entry.large ? AA_LARGE : AA_SMALL };
      })
      .sort((a, b) => a.ratio - b.ratio);

    const halos = await cdp.evaluate(`(() => {
      const selectors = ['.event-entry .event-body', '.event-time', '.session-header h2', '.session-meta', '#control-status', '.empty-state p'];
      return [...document.querySelectorAll(selectors.join(','))]
        .map((el) => getComputedStyle(el).textShadow)
        .filter((value) => value && value !== 'none');
    })()`);
    if (halos.length) problems.push(`${viewport.name}: ${halos.length} text styles carry a text-shadow halo (${halos[0]}), which blurs glyph edges`);

    // --- 5. Assertions ---
    const measuredFloor = shipped.floor;
    const primaryRatio = contrastOf(measuredFloor, luminance([20, 20, 28]));
    const secondaryRatio = contrastOf(measuredFloor, luminance([22, 25, 31]));
    if (primaryRatio < AA_SMALL) problems.push(`${viewport.name}: body text over the scrim measures ${primaryRatio.toFixed(2)}:1, below AA`);
    // Passing AA is not the same as being crisp: bar text at 4.5:1 on a mid tone reads
    // soft, so the shipped floor has to clear 6:1 for body copy.
    if (primaryRatio < 6) problems.push(`${viewport.name}: body text over the scrim measures ${primaryRatio.toFixed(2)}:1, too close to the AA floor to look crisp`);
    if (secondaryRatio < AA_SMALL) problems.push(`${viewport.name}: secondary text over the scrim measures ${secondaryRatio.toFixed(2)}:1, below AA`);
    if (shipped.peak - shipped.floor < 0.1) problems.push(`${viewport.name}: the scrim flattened the photo (brightness spread ${(shipped.peak - shipped.floor).toFixed(3)}), it should be a floor, not a wash`);
    const detailRetention = shipped.detail / bare.detail;
    const chromaRetention = shipped.chroma / bare.chroma;
    // Colour and texture are what the reader judges the background on, so they are
    // asserted, not just reported: a flat floor shifts hue by tens of degrees.
    // A uniform veil changes every pixel by design; what must hold is that it changes
    // them *evenly* — texture and hue have to survive the wash.
    if (photoChange.detailKept !== null && photoChange.detailKept < 0.55) problems.push(`${viewport.name}: the veil keeps only ${Math.round(photoChange.detailKept * 100)}% of the texture, which reads as a flat wash`);
    if (photoChange.hueShift !== null && photoChange.hueShift > 15) problems.push(`${viewport.name}: the scrim rotates colour by ${photoChange.hueShift.toFixed(1)}°, so the background no longer matches the picture`);
    if (photoChange.clipped > 0.02) problems.push(`${viewport.name}: the scrim blows ${Math.round(photoChange.clipped * 100)}% of the lifted pixels to pure white`);
    // A readable floor lifts the photo's dark end, so it always costs local contrast.
    // These are the measured limits of the shipped floor, not aspirations: 64–70%
    // detail and 46–47% chroma. Anything below means the scrim got heavier again.
    if (detailRetention < 0.55) problems.push(`${viewport.name}: the scrim keeps only ${Math.round(detailRetention * 100)}% of the photo's detail`);
    // A white veil mixes white into every pixel, so it always costs saturation: measured\n    // 38–45% at alpha 0.55–0.62. Below a third the photo reads as grey, not as itself.\n    if (chromaRetention < 0.35) problems.push(`${viewport.name}: the veil keeps only ${Math.round(chromaRetention * 100)}% of the photo's colour`);
    if (bare.floor >= measuredFloor) problems.push(`${viewport.name}: the scrim does not actually lift the background (${bare.floor.toFixed(3)} -> ${measuredFloor.toFixed(3)})`);
    for (const entry of worst) {
      if (entry.ratio < entry.threshold) problems.push(`${viewport.name}: ${entry.sample} ("${entry.text}") is ${entry.ratio}:1 over the floor, needs ${entry.threshold}:1`);
    }

    report.push({
      viewport: `${viewport.name} ${viewport.width}x${viewport.height}@${viewport.dpr}`,
      floor: Number(measuredFloor.toFixed(3)),
      bareFloor: Number(bare.floor.toFixed(3)),
      primary: Number(primaryRatio.toFixed(2)),
      secondary: Number(secondaryRatio.toFixed(2)),
      spread: Number((shipped.peak - shipped.floor).toFixed(2)),
      detail: `${Math.round(detailRetention * 100)}%`,
      chroma: `${Math.round(chromaRetention * 100)}%`,
      untouched: `${Math.round(photoChange.untouched * 100)}%`,
      liftedDetail: photoChange.detailKept === null ? "n/a" : `${Math.round(photoChange.detailKept * 100)}%`,
      hueShift: photoChange.hueShift === null ? "n/a" : `${photoChange.hueShift.toFixed(1)}°`,
      clipped: `${(photoChange.clipped * 100).toFixed(1)}%`,
      worstText: worst.slice(0, 3).map((entry) => `${entry.sample} ${entry.ratio}:1`),
      floorVariable: layers.floorVariable,
      scrim: `${layers.scrim.background} / ${layers.scrim.mixBlendMode}`,
    });
  }

  // --- 6. The "more contrast" floors must actually be stronger ---
  const shippedFloorColour = await cdp.evaluate(`getComputedStyle(document.body, '::after').backgroundColor`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const reduced = await cdp.evaluate(`getComputedStyle(document.body, '::after').backgroundColor`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-contrast", value: "more" }] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const highContrast = await cdp.evaluate(`getComputedStyle(document.body, '::after').backgroundColor`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const alphaOf = (value) => {
    const parts = String(value).match(/[\d.]+/g)?.map(Number) ?? [];
    return parts.length >= 4 ? parts[3] : 1;
  };
  const shippedAlpha = alphaOf(shippedFloorColour);
  if (!(alphaOf(reduced) > shippedAlpha + 0.05)) {
    problems.push(`prefers-reduced-transparency does not strengthen the veil (${reduced})`);
  }
  if (!(alphaOf(highContrast) > shippedAlpha + 0.05)) {
    problems.push(`prefers-contrast: more does not strengthen the veil (${highContrast})`);
  }

  for (const line of report) console.log(JSON.stringify(line));
  console.log(`media: prefers-reduced-transparency -> ${reduced}; prefers-contrast:more -> ${highContrast}`);

  if (problems.length) {
    console.error("\nScrim verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("PASS  the whole-page scrim lifts the background to a measured floor and every text colour clears AA on it");
  }
} finally {
  cdp?.close();
  browser.kill();
  await bridge.server.close();
  await bridge.sessions.shutdown?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await rm(directory, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort.
  }
}
