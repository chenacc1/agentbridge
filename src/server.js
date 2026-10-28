import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { loadConfig, isLoopback } from "./config.js";
import { EventStore } from "./event-store.js";
import { PairingManager } from "./pairing.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { SessionManager } from "./session-manager.js";
import { EchoAdapter } from "./adapters/echo.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { DeepSeekHarnessAdapter } from "./adapters/deepseek-harness.js";
import { DshDesktopAdapter } from "./adapters/dsh-desktop.js";
import { ZCodeNativeAdapter } from "./adapters/zcode-native.js";
import { DshDesktopChannelManager } from "./dsh-desktop-channels.js";
import { WorkspaceCatalog } from "./workspaces/workspace-catalog.js";
import { ConversationCatalog } from "./conversations/conversation-catalog.js";
import { Notifier } from "./notifier.js";
import { AttachmentStore, isImage } from "./attachments.js";
import { notificationLink, writeNotifyConfig } from "./config.js";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(sourceDir, "../public");

// How much of the newest event stream a fresh page receives before it asks for
// one conversation's history on demand.
const INITIAL_REPLAY_EVENTS = 500;

function json(res, statusCode, value, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function errorResponse(res, error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const payload = { error: statusCode === 500 ? "Internal server error" : error.message };
  if (statusCode !== 500 && typeof error.code === "string") payload.code = error.code;
  if (statusCode !== 500 && error.diagnostics && typeof error.diagnostics === "object") payload.diagnostics = error.diagnostics;
  json(res, statusCode, payload);
}

function parseCookies(header = "") {
  const cookies = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index > 0) cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return cookies;
}

function requestToken(req) {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return parseCookies(req.headers.cookie).agentbridge_session ?? null;
}

/** Raw upload body: attachments are binary, so they get their own reader. */
async function readBinary(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req, maxBytes = 64 * 1024) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try { originHost = new URL(origin).host; } catch { originHost = ""; }
  if (originHost !== req.headers.host) {
    throw Object.assign(new Error("Cross-origin state changes are not allowed"), { statusCode: 403 });
  }
}

function sessionCookie(token, secure, sessionTtlMs) {
  const maxAge = Math.max(1, Math.floor(sessionTtlMs / 1000));
  return `agentbridge_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function accessKeyCookie(key, secure) {
  return `agentbridge_key=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000${secure ? "; Secure" : ""}`;
}

function keyMatches(presented, accessKey) {
  if (!presented) return false;
  const candidate = createHash("sha256").update(String(presented)).digest();
  const expected = createHash("sha256").update(accessKey).digest();
  return timingSafeEqual(candidate, expected);
}

// When AGENTBRIDGE_ACCESS_KEY is set, every non-loopback request must carry the
// key (pairing-URL query param, x-agentbridge-key header, or the cookie set by
// /api/access). Loopback traffic is exempt so local tooling keeps working.
export function hasAccessKey(req, url, config) {
  if (!config.accessKey) return true;
  if (isLoopback(req.socket.remoteAddress)) return true;
  const presented = url.searchParams.get("key")
    ?? req.headers["x-agentbridge-key"]
    ?? parseCookies(req.headers.cookie).agentbridge_key;
  return keyMatches(presented, config.accessKey);
}

function requireAccessKey(req, url, config) {
  if (!hasAccessKey(req, url, config)) {
    throw Object.assign(new Error("Access key required"), { statusCode: 401 });
  }
}

async function registerLocalProject(workspaceCatalog, projects, requestedPath) {
  const workspace = await workspaceCatalog.register({ requestedPath, source: "local" });
  projects.set(workspace.alias, workspace.canonicalPath);
  return {
    id: workspace.id,
    alias: workspace.alias,
    name: workspace.name,
    cwd: workspace.canonicalPath,
  };
}

// KaTeX ships its own CSS and fonts. Serving them from the installed package
// keeps formula rendering local: nothing about this bridge is fetched from a CDN.
const KATEX_DIR = path.resolve(sourceDir, "../node_modules/katex/dist");
const KATEX_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data:; "
  // KaTeX positions every glyph with an inline style attribute, so formulas need
  // inline styles. Scripts stay restricted to same-origin files.
  + "style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

async function serveKatex(res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice("/vendor/katex/".length));
  } catch {
    return false;
  }
  if (!relative || relative.includes("..") || relative.includes("\\") || relative.includes("\0")) return false;
  const type = KATEX_TYPES[path.extname(relative).toLowerCase()];
  if (!type) return false;
  const filePath = path.resolve(KATEX_DIR, relative);
  if (!filePath.startsWith(KATEX_DIR + path.sep)) return false;
  let content;
  try {
    content = await readFile(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(content);
  return true;
}

/**
 * Immutable caching for the shell's own assets.
 *
 * Everything used to be `no-store`, which meant a phone re-downloaded the app and
 * the 456 KB background on every single visit — the most expensive part of opening
 * the console over a tunnel. Each asset now carries a content hash in its URL
 * (`/app.js?v=ab12cd34`), the HTML itself stays `no-store`, and a request whose
 * version matches is cached for a year. Changing a file changes its hash, so there
 * is no stale-asset failure mode: the shell always asks for the current one.
 */
const ASSET_VERSIONS = new Map();
// The rewritten shell is memoised, but keyed on the source files' mtime+size: editing a
// file under public/ must take effect on the next request, exactly as it did before
// versioning existed. Only a real content change pays for the rebuild.
const SHELL_SOURCES = [
  "index.html", "styles.css", "app.js", "adapter-capabilities.js", "workspace-navigation.js",
  "markdown.js", "highlight.js", "transcript.js", "command-id.js", "background.jpg",
];
let SHELL_HTML = null;
let SHELL_KEY = null;

async function currentShell() {
  const parts = await Promise.all(SHELL_SOURCES.map(async (file) => {
    const info = await stat(path.join(publicDir, file));
    return `${file}:${info.mtimeMs}:${info.size}`;
  }));
  const key = parts.join("|");
  if (SHELL_HTML && key === SHELL_KEY) return SHELL_HTML;
  SHELL_HTML = await buildShell();
  SHELL_KEY = key;
  return SHELL_HTML;
}

function assetVersion(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 10);
}

async function buildShell() {
  const read = (file) => readFile(path.join(publicDir, file));
  const [html, css, app, adapterCaps, navigation, markdown, highlight, transcript, commandId, background] = await Promise.all([
    read("index.html"), read("styles.css"), read("app.js"), read("adapter-capabilities.js"),
    read("workspace-navigation.js"), read("markdown.js"), read("highlight.js"),
    read("transcript.js"), read("command-id.js"), read("background.jpg"),
  ]);
  // One version for the whole JS bundle graph. Hashing each module separately would
  // need a transitive pass (a change in markdown.js must also invalidate transcript.js,
  // which imports it), and the modules are a few dozen KB — so one stamp is both
  // simpler and correct. The photo gets its own, because it is the only large asset
  // and the stylesheet can carry its version.
  const jsBundle = Buffer.concat([app, adapterCaps, navigation, markdown, highlight, transcript, commandId]);
  const jsVersion = assetVersion(jsBundle);
  const photoVersion = assetVersion(background);
  const cssText = css.toString("utf8").replace(/url\("\/background\.jpg"\)/g, `url("/background.jpg?v=${photoVersion}")`);
  const cssVersion = assetVersion(Buffer.from(cssText, "utf8"));
  for (const file of ["app.js", "adapter-capabilities.js", "workspace-navigation.js", "markdown.js", "highlight.js", "transcript.js", "command-id.js"]) {
    ASSET_VERSIONS.set(`/${file}`, jsVersion);
  }
  ASSET_VERSIONS.set("/styles.css", cssVersion);
  ASSET_VERSIONS.set("/background.jpg", photoVersion);

  let appText = app.toString("utf8");
  for (const file of ["adapter-capabilities.js", "workspace-navigation.js", "markdown.js", "highlight.js", "transcript.js", "command-id.js"]) {
    appText = appText.split(`from "/${file}"`).join(`from "/${file}?v=${jsVersion}"`);
  }
  // transcript.js imports markdown.js and highlight.js, which app.js never mentions.
  const transcriptText = transcript.toString("utf8")
    .split('from "/markdown.js"').join(`from "/markdown.js?v=${jsVersion}"`)
    .split('from "/highlight.js"').join(`from "/highlight.js?v=${jsVersion}"`);

  let shell = html.toString("utf8");
  shell = shell.split('"/styles.css"').join(`"/styles.css?v=${cssVersion}"`);
  shell = shell.split('"/app.js"').join(`"/app.js?v=${jsVersion}"`);
  return { shell, cssText, appText, transcriptText, jsVersion, cssVersion, photoVersion };
}
async function serveStatic(res, pathname, search) {
  if (pathname.startsWith("/vendor/katex/")) return serveKatex(res, pathname);
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/pair": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/adapter-capabilities.js": ["adapter-capabilities.js", "text/javascript; charset=utf-8"],
    "/workspace-navigation.js": ["workspace-navigation.js", "text/javascript; charset=utf-8"],
    "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
    "/highlight.js": ["highlight.js", "text/javascript; charset=utf-8"],
    "/transcript.js": ["transcript.js", "text/javascript; charset=utf-8"],
    "/command-id.js": ["command-id.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/background.jpg": ["background.jpg", "image/jpeg"],
  };
  const target = files[pathname];
  if (!target) return false;
  const version = new URLSearchParams(search ?? "").get("v");
  const currentVersion = ASSET_VERSIONS.get(pathname);
  const immutable = Boolean(version && currentVersion && version === currentVersion);
  // The stylesheet is rewritten so its own URL only changes when the photo does.
  const shell = await currentShell();
  const content = pathname === "/styles.css"
    ? Buffer.from(shell.cssText, "utf8")
    : pathname === "/app.js"
      ? Buffer.from(shell.appText, "utf8")
      : pathname === "/transcript.js"
        ? Buffer.from(shell.transcriptText, "utf8")
        : pathname === "/" || pathname === "/pair"
          ? Buffer.from(shell.shell, "utf8")
          : await readFile(path.join(publicDir, target[0]));
  res.writeHead(200, {
    "content-type": target[1],
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(content);
  return true;
}

export async function createBridge(options = {}) {
  const config = options.config ?? loadConfig();
  const workspaceCatalog = options.workspaceCatalog ?? new WorkspaceCatalog({
    filePath: path.join(config.dataDir, "workspaces.json"),
    initialProjects: config.projects,
  });
  await workspaceCatalog.init();
  for (const workspace of workspaceCatalog.list()) {
    if (workspace.enabled) config.projects.set(workspace.alias, workspace.canonicalPath);
  }
  const eventStore = options.eventStore ?? new EventStore({ filePath: path.join(config.dataDir, "events.jsonl") });
  await eventStore.init();
  const conversationCatalog = options.conversationCatalog ?? new ConversationCatalog({
    filePath: path.join(config.dataDir, "bridge-sessions.json"),
  });
  await conversationCatalog.init();
  const pairing = options.pairing ?? new PairingManager({
    ...config,
    storePath: config.dataDir ? path.join(config.dataDir, "sessions.json") : null,
  });
  const registry = options.registry ?? new AdapterRegistry();
  const dshDesktopChannels = options.dshDesktopChannels ?? new DshDesktopChannelManager();
  if (!options.registry) {
    registry.register(new EchoAdapter());
    registry.register(new CodexAdapter());
    registry.register(new ClaudeAdapter());
    registry.register(new DeepSeekHarnessAdapter());
    registry.register(new DshDesktopAdapter({ channels: dshDesktopChannels }));
    registry.register(new ZCodeNativeAdapter());
  }
  // Notifications are optional: an unset webhook keeps the notifier inert.
  const notifier = options.notifier ?? new Notifier({
    webhookUrl: config.notifyWebhook,
    format: config.notifyFormat,
    chatId: config.notifyChatId,
    token: config.notifyToken,
    channel: config.notifyChannel,
    muted: config.notifyMuted,
    linkUrl: notificationLink(config),
    logger: console,
  });
  // One read of the shell per process; index.html and styles.css are rewritten from
  // it, so a deploy changes hashes without a build step.
  await currentShell();
  const attachments = options.attachments ?? new AttachmentStore({ dataDir: config.dataDir });
  await attachments.init();
  const sessions = options.sessions ?? new SessionManager({
    eventStore,
    registry,
    projects: config.projects,
    conversationCatalog,
    workspaceCatalog,
    notifier,
    attachments,
  });
  let currentPairing = pairing.createPairing(config.advertisedOrigin);
  const dshQrTargets = new Map();
  let shuttingDown = false;
  let shutdownPromise = null;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await sessions.shutdown();
      await new Promise((resolve, reject) => {
        const forceClose = setTimeout(() => server.closeAllConnections?.(), 1_500);
        forceClose.unref?.();
        server.close((error) => {
          clearTimeout(forceClose);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      });
      await options.onShutdown?.();
    })();
    return shutdownPromise;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, shuttingDown ? 503 : 200, { ok: !shuttingDown, shuttingDown, lastSeq: eventStore.lastSeq });
      }

      if (shuttingDown) throw Object.assign(new Error("AgentBridge is shutting down"), { statusCode: 503, code: "BRIDGE_SHUTTING_DOWN" });

      // Key-exchange endpoint: exempt from the gate itself, but rate-worthy of
      // the same-origin check so other sites cannot plant the key cookie.
      if (req.method === "POST" && url.pathname === "/api/access") {
        if (!config.accessKey) throw Object.assign(new Error("Access key gate is not enabled"), { statusCode: 404 });
        requireSameOrigin(req);
        const body = await readJson(req);
        if (!keyMatches(body.key, config.accessKey)) {
          throw Object.assign(new Error("Access key is incorrect"), { statusCode: 401 });
        }
        return json(res, 200, { ok: true }, { "set-cookie": accessKeyCookie(config.accessKey, config.secureCookies) });
      }

      let localMatch;
      if (req.method === "GET" && (localMatch = url.pathname.match(/^\/api\/local\/dsh-desktop\/channels\/([^/]+)\/poll$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        return json(res, 200, dshDesktopChannels.poll(localMatch[1], requestToken(req), url.searchParams.get("after")));
      }

      if (req.method === "POST" && (localMatch = url.pathname.match(/^\/api\/local\/dsh-desktop\/channels\/([^/]+)\/events$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        // 1 MB keeps a busy session's event batches under the cap: the companion picks
        // batches by byte budget, and the events the phone actually displays are small.
        const body = await readJson(req, 1024 * 1024);
        // The integration shrinks any single event that could not share a batch, so
        // the cap still bounds one batch instead of refusing it.
        return json(res, 202, await dshDesktopChannels.ingest(localMatch[1], requestToken(req), body.events));
      }

      if (req.method === "POST" && (localMatch = url.pathname.match(/^\/api\/local\/dsh-desktop\/channels\/([^/]+)\/interactions$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const body = await readJson(req, 256 * 1024);
        return json(res, 202, await dshDesktopChannels.ingestInteractions(localMatch[1], requestToken(req), body.interactions));
      }

      if (req.method === "POST" && (localMatch = url.pathname.match(/^\/api\/local\/dsh-desktop\/channels\/([^/]+)\/results$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const body = await readJson(req);
        return json(res, 202, dshDesktopChannels.complete(localMatch[1], requestToken(req), String(body.requestId ?? ""), body.result));
      }

      if (req.method === "GET" && (localMatch = url.pathname.match(/^\/api\/local\/dsh-desktop\/channels\/([^/]+)\/qr\.svg$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const target = dshQrTargets.get(localMatch[1]);
        if (!target || target.expiresAt <= Date.now()) throw Object.assign(new Error("Pairing QR has expired"), { statusCode: 410 });
        const svg = await QRCode.toString(target.url, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        return res.end(svg);
      }

      if (req.method === "GET" && (localMatch = url.pathname.match(/^\/api\/local\/pairings\/([^/]+)\/qr\.svg$/))) {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const target = pairing.getPendingPairing(localMatch[1]);
        const svg = await QRCode.toString(target.url, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        return res.end(svg);
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        return json(res, 200, { machineName: config.machineName, pairing: currentPairing });
      }

      if (req.method === "GET" && url.pathname === "/api/pairing/qr.svg") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const svg = await QRCode.toString(currentPairing.url, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        return res.end(svg);
      }

      if (req.method === "POST" && url.pathname === "/api/pairing/rotate") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        currentPairing = pairing.createPairing(config.advertisedOrigin);
        return json(res, 201, { pairing: currentPairing });
      }

      if (req.method === "POST" && url.pathname === "/api/local-session") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        const local = pairing.createSession("Desktop browser");
        return json(res, 201, { device: { id: local.id, deviceName: local.deviceName, expiresAt: local.expiresAt } }, {
          // The desktop dashboard is intentionally opened over loopback HTTP,
          // even when the advertised phone origin is HTTPS (Cloudflare mode).
          // A Secure cookie would be discarded by the local browser.
          "set-cookie": sessionCookie(local.token, false, config.sessionTtlMs),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/local/workspaces") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        const body = await readJson(req);
        const project = await registerLocalProject(workspaceCatalog, config.projects, body.path);
        const workspace = workspaceCatalog.listPublic().find((item) => item.id === project.id);
        return json(res, 201, { workspace });
      }

      if (req.method === "POST" && url.pathname === "/api/local/phone") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        const body = await readJson(req);
        const project = await registerLocalProject(workspaceCatalog, config.projects, body.cwd);
        const device = pairing.createSession("Local launcher");
        const sessionInput = {
          adapterId: String(body.adapterId || "claude"),
          projectAlias: project.alias,
          providerSessionId: body.providerSessionId,
          title: body.title,
          commandId: String(body.commandId || `local-${Date.now()}`),
          device,
        };
        const session = body.providerSessionId
          ? await sessions.attach(sessionInput)
          : await sessions.create(sessionInput);
        currentPairing = pairing.createPairing(config.advertisedOrigin, { targetSessionId: session.id });
        const address = server.address();
        const localPort = typeof address === "object" && address ? address.port : config.port;
        const qrImageUrl = `http://127.0.0.1:${localPort}/api/local/pairings/${encodeURIComponent(currentPairing.id)}/qr.svg`;
        return json(res, 201, { session, pairing: currentPairing, qrImageUrl, project: { alias: project.alias } });
      }

      if (req.method === "POST" && url.pathname === "/api/local/dsh-desktop/register") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        const body = await readJson(req, 1024 * 1024);
        const providerSessionId = String(body.sessionId ?? "");
        if (providerSessionId.length < 8 || providerSessionId.length > 200) {
          throw Object.assign(new Error("A valid DSH session id is required"), { statusCode: 400 });
        }
        const project = await registerLocalProject(workspaceCatalog, config.projects, body.cwd);
        const title = String(body.title || `${path.basename(project.cwd)} · DSH Desktop`).slice(0, 100);
        // The DSH-side integration is a copy inside the DSH profile; a stale copy is
        // the classic "I changed it but nothing happened" trap, so the bridge records
        // what it was told and says so out loud.
        const integrationVersion = Number.isSafeInteger(body.integrationVersion) ? body.integrationVersion : 0;        const registration = dshDesktopChannels.register({
          providerSessionId,
          cwd: project.cwd,
          title,
          provider: String(body.provider || "").slice(0, 100),
          model: String(body.model || "").slice(0, 160),
          modelDirectory: body.modelDirectory,
          integrationVersion,
        });
        const channel = {
          id: registration.id,
          token: registration.token,
          pollPath: `/api/local/dsh-desktop/channels/${registration.id}/poll`,
          eventsPath: `/api/local/dsh-desktop/channels/${registration.id}/events`,
          interactionsPath: `/api/local/dsh-desktop/channels/${registration.id}/interactions`,
          resultsPath: `/api/local/dsh-desktop/channels/${registration.id}/results`,
        };
        // A conversation the phone asked for: the bridge session already exists in
        // `starting`, so registration completes that request instead of minting a
        // second pairing. The waiting `adapter.start()` binds the provider session.
        const bridgeSessionId = typeof body.bridgeSessionId === "string" ? body.bridgeSessionId : "";
        if (bridgeSessionId) {
          const settled = dshDesktopChannels.settleCreate(bridgeSessionId, {
            providerSessionId,
            title,
            provider: String(body.provider || "").slice(0, 100),
            model: String(body.model || "").slice(0, 160),
            modelDirectory: dshDesktopChannels.metadata(providerSessionId)?.modelDirectory ?? null,
          });
          if (!settled) dshDesktopChannels.revoke(registration.id);
          if (!settled) throw Object.assign(new Error("That create request is no longer waiting"), { statusCode: 409 });
          return json(res, 201, {
            created: true,
            sessionId: bridgeSessionId,
            project: { alias: project.alias, cwd: project.cwd },
            channel,
          });
        }
        // A reconnect is the companion noticing the bridge forgot its channel. It
        // must not consume a pairing code, mint a device, or take the lease away
        // from the phone that is already driving this conversation.
        const reconnecting = body.reconnect === true;
        const device = reconnecting ? null : pairing.createSession("DSH Desktop /phone");
        let session;
        try {
          session = await sessions.attach({
            adapterId: "deepseek-harness-desktop",
            projectAlias: project.alias,
            providerSessionId,
            title,
            commandId: `dsh-phone-${registration.id}`,
            device,
          });
        } catch (error) {
          dshDesktopChannels.revoke(registration.id);
          throw error;
        }
        if (reconnecting) {
          return json(res, 200, {
            session,
            reconnected: true,
            project: { alias: project.alias, cwd: project.cwd },
            channel,
          });
        }
        currentPairing = pairing.createPairing(config.advertisedOrigin, { targetSessionId: session.id });
        dshQrTargets.set(registration.id, { url: currentPairing.url, expiresAt: currentPairing.expiresAt });
        const address = server.address();
        const localPort = typeof address === "object" && address ? address.port : config.port;
        const qrImageUrl = `http://127.0.0.1:${localPort}/api/local/dsh-desktop/channels/${registration.id}/qr.svg`;
        return json(res, 201, {
          session,
          pairing: currentPairing,
          project: { alias: project.alias, cwd: project.cwd },
          qrImageUrl,
          channel,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/pairings/exchange") {
        requireAccessKey(req, url, config);
        requireSameOrigin(req);
        const body = await readJson(req);
        const mobile = pairing.exchange(body.code, String(body.deviceName || "WeChat mobile").slice(0, 80));
        if (mobile.targetSessionId) {
          await sessions.claimControl({
            sessionId: mobile.targetSessionId,
            commandId: `pairing-${body.code}`,
            device: mobile,
            force: true,
          });
        }
        return json(res, 201, {
          device: { id: mobile.id, deviceName: mobile.deviceName, expiresAt: mobile.expiresAt },
          targetSessionId: mobile.targetSessionId,
        }, {
          "set-cookie": sessionCookie(mobile.token, config.secureCookies, config.sessionTtlMs),
        });
      }

      // This is deliberately not a pairing QR. It only opens the stable app
      // address, where an already-paired phone can use its existing cookie.
      if (req.method === "GET" && url.pathname === "/api/return-qr.svg") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const entryUrl = `${config.advertisedOrigin}/${config.accessKey ? `?key=${encodeURIComponent(config.accessKey)}` : ""}`;
        const image = await QRCode.toString(entryUrl, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        return res.end(image);
      }

      // The application shell is public so a newly scanned phone can render the
      // pairing screen before it owns a session cookie. All data APIs below this
      // point remain authenticated (and gated by the access key when enabled).
      if (req.method === "GET" && await serveStatic(res, url.pathname, url.search)) return;

      requireAccessKey(req, url, config);
      const device = pairing.authenticate(requestToken(req));
      if (!device) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });

      if (req.method === "GET" && url.pathname === "/api/devices") {
        return json(res, 200, { devices: pairing.listDevices(), currentDeviceId: device.id });
      }

      if (req.method === "GET" && url.pathname === "/api/workspaces") {
        return json(res, 200, {
          revision: workspaceCatalog.revision,
          items: workspaceCatalog.listPublic(),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/conversations") {
        const workspaceId = String(url.searchParams.get("workspaceId") ?? "");
        const adapterId = String(url.searchParams.get("adapterId") ?? "");
        const workspace = workspaceCatalog.get(workspaceId);
        if (!workspace || !workspace.enabled) throw Object.assign(new Error("Workspace not found"), { statusCode: 404 });
        const refresh = url.searchParams.get("refresh") === "1";
        let discovery = null;
        if (refresh) {
          requireSameOrigin(req);
          if (!adapterId) throw Object.assign(new Error("adapterId is required for provider discovery"), { statusCode: 400 });
          discovery = await sessions.discover({ workspaceId: workspace.id, adapterId });
        }
        return json(res, 200, {
          revision: conversationCatalog.revision,
          items: sessions.list({ workspaceId: workspace.id, adapterId: adapterId || null }),
          ...(discovery ? { discovery: {
            created: discovery.created,
            updated: discovery.updated,
            diagnostics: discovery.diagnostics,
          } } : {}),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, 200, {
          machine: { id: "local", name: config.machineName },
          device,
          projects: workspaceCatalog.listPublic().map((workspace) => workspace.alias),
          workspaces: workspaceCatalog.listPublic(),
          adapters: await registry.describe(),
          sessions: sessions.list(),
          lastSeq: eventStore.lastSeq,
          notifications: { enabled: notifier.enabled, format: notifier.format, channel: notifier.channel, muted: notifier.muted },
          desktopIntegration: dshDesktopChannels.integrationStatus(),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/search") {
        const query = String(url.searchParams.get("q") ?? "").slice(0, 200);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30;
        const found = await eventStore.search(query, { limit });
        const titles = new Map(sessions.list().map((session) => [session.id, session]));
        return json(res, 200, {
          query,
          truncated: found.truncated,
          scanned: found.scanned,
          hits: found.hits.map((hit) => {
            const session = titles.get(hit.sessionId) ?? null;
            return {
              ...hit,
              sessionTitle: session?.title ?? null,
              adapterId: session?.adapterId ?? null,
            };
          }),
        }, { "cache-control": "no-store" });
      }

      // The mute switch lives on the phone, so this endpoint cannot be loopback-only.
      // It touches exactly one thing (the `muted` flag) and persists it, so the state
      // survives a restart and a double-clicked launcher.
      if (req.method === "POST" && url.pathname === "/api/notifications") {
        const body = await readJson(req);
        if (typeof body.muted !== "boolean") throw Object.assign(new Error("muted must be true or false"), { statusCode: 400 });
        const muted = notifier.setMuted(body.muted);
        writeNotifyConfig(config.dataDir, { muted });
        return json(res, 200, { notifications: { enabled: notifier.enabled, format: notifier.format, channel: notifier.channel, muted } });
      }

      if (req.method === "POST" && url.pathname === "/api/recent-session") {
        requireSameOrigin(req);
        const body = await readJson(req);
        const sessionId = String(body.sessionId ?? "");
        if (!sessions.get(sessionId)) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        pairing.setLastSession(device.id, sessionId);
        return json(res, 200, { resumeSessionId: sessionId });
      }

      const historyMatch = req.method === "GET"
        ? url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/)
        : null;
      if (historyMatch) {
        const target = sessions.get(decodeURIComponent(historyMatch[1]));
        if (!target) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "300", 10);
        const beforeSeq = Number.parseInt(url.searchParams.get("before") ?? "", 10);
        const history = await eventStore.readSessionHistory(target.id, {
          limit,
          beforeSeq: Number.isSafeInteger(beforeSeq) ? beforeSeq : null,
        });
        return json(res, 200, { sessionId: target.id, ...history }, { "cache-control": "no-store" });
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        // A brand-new page has no cursor, and replaying the whole window made the
        // phone wait on megabytes over the tunnel before showing anything. A
        // fresh load gets the newest slice; older conversations are fetched per
        // session through /api/sessions/:id/history, which is what switching
        // conversations needs anyway. A reconnect still resumes from the
        // browser's own Last-Event-ID.
        const requested = Number.parseInt(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? "0", 10) || 0;
        const after = requested || Math.max(0, eventStore.lastSeq - INITIAL_REPLAY_EVENTS);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        const writeEvent = (event) => {
          res.write(`id: ${event.seq}\nevent: agent-event\ndata: ${JSON.stringify(event)}\n\n`);
        };
        for (const event of eventStore.listAfter(after)) writeEvent(event);
        const unsubscribe = eventStore.subscribe(writeEvent);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (req.method === "POST") requireSameOrigin(req);
      let match;
      if (req.method === "POST" && url.pathname === "/api/local/shutdown") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const active = sessions.list().filter((session) => ["starting", "running", "stopping"].includes(session.status));
        if (active.length) {
          throw Object.assign(new Error("仍有 Agent 任务正在运行，请先停止任务再关闭 Bridge"), {
            statusCode: 409,
            code: "ACTIVE_SESSIONS",
            diagnostics: {
              count: active.length,
              sessions: active.map(({ id, title, status, adapterId }) => ({ id, title, status, adapterId })),
            },
          });
        }
        shuttingDown = true;
        json(res, 202, { accepted: true, message: "AgentBridge 正在安全停止" });
        setImmediate(() => {
          void shutdown().catch((error) => {
            console.error("AgentBridge safe shutdown failed", error);
            shuttingDown = false;
            shutdownPromise = null;
          });
        });
        return;
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/))) {
        const targetId = decodeURIComponent(match[1]);
        if (!pairing.revoke(targetId)) throw Object.assign(new Error("Device not found"), { statusCode: 404 });
        const headers = targetId === device.id
          ? { "set-cookie": `agentbridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.secureCookies && !isLoopback(req.socket.remoteAddress) ? "; Secure" : ""}` }
          : {};
        return json(res, 200, { revoked: true }, headers);
      }
      if (req.method === "POST" && url.pathname === "/api/local/notify-test") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        const result = await notifier.send("notify.test", {}, {
          machineName: config.machineName,
          sessionTitle: "通知链路测试",
          adapterId: "agentbridge",
        });
        return json(res, result.sent ? 200 : 409, { enabled: notifier.enabled, format: notifier.format, channel: notifier.channel, muted: notifier.muted, ...result });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readJson(req);
        const session = await sessions.create({ ...body, device });
        return json(res, 201, { session });
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments$/))) {
        const session = sessions.get(decodeURIComponent(match[1]));
        if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        sessions.requireControlFor(session.id, device);
        const name = decodeURIComponent(String(req.headers["x-attachment-name"] ?? "attachment"));
        const mimeType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
        // Answer an oversized upload with a real 413 instead of letting the socket
        // reset: a phone has to be able to tell "too big" from "no connection".
        const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
        if (Number.isSafeInteger(declared) && declared > attachments.maxBytes) {
          await new Promise((resolve) => {
            let drained = 0;
            const stop = () => { req.off("data", onData); req.off("end", stop); req.off("error", stop); resolve(); };
            const onData = (chunk) => {
              drained += chunk.length;
              if (drained > 32 * 1024 * 1024) { req.destroy(); stop(); }
            };
            req.on("data", onData);
            req.on("end", stop);
            req.on("error", stop);
          });
          throw Object.assign(new Error(`附件不能超过 ${Math.round(attachments.maxBytes / 1024 / 1024)} MB`), { statusCode: 413 });
        }
        const data = await readBinary(req, attachments.maxBytes);
        const stored = await attachments.save({ sessionId: session.id, name, mimeType, data });
        return json(res, 201, {
          attachment: {
            id: stored.id,
            name: stored.name,
            mimeType: stored.mimeType,
            bytes: stored.bytes,
            previewUrl: `/api/attachments/${stored.id}`,
            isImage: isImage(stored.mimeType),
          },
        });
      }
      if (req.method === "GET" && (match = url.pathname.match(/^\/api\/attachments\/([^/]+)$/))) {
        const entry = attachments.get(decodeURIComponent(match[1]));
        if (!entry) throw Object.assign(new Error("Attachment not found"), { statusCode: 404 });
        const file = await attachments.read(entry.id);
        if (!file) throw Object.assign(new Error("Attachment file is missing"), { statusCode: 404 });
        res.writeHead(200, {
          "content-type": entry.mimeType || "application/octet-stream",
          "content-length": String(file.data.length),
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
          // An attachment is user data under a random id; it never changes, so it
          // can be cached by the phone for the life of the conversation.
          "cache-control": "private, max-age=86400",
        });
        res.end(file.data);
        return;
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
        const body = await readJson(req);
        return json(res, 202, await sessions.send({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.selectModel({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/cancel$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.cancelQueued({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/auto-approve$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.setAutoApproval({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.stop({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/control$/))) {
        const body = await readJson(req);
        return json(res, 200, { controller: await sessions.claimControl({ sessionId: match[1], ...body, device }) });
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/approvals\/([^/]+)$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.resolveApproval({ approvalId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/requests\/([^/]+)$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.resolveInput({ requestId: decodeURIComponent(match[1]), ...body, device }));
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      if (!Number.isInteger(error.statusCode) || error.statusCode >= 500) console.error(error);
      if (!res.headersSent) errorResponse(res, error);
      else res.end();
    }
  });

  return {
    server,
    config,
    eventStore,
    pairing,
    registry,
    sessions,
    dshDesktopChannels,
    notifier,
    attachments,
    workspaceCatalog,
    conversationCatalog,
    getCurrentPairing: () => currentPairing,
    shutdown,
  };
}

export async function startBridge() {
  const bridge = await createBridge();
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(bridge.config.port, bridge.config.host, resolve);
  });
  console.log(`AgentBridge running at http://127.0.0.1:${bridge.config.port}`);
  console.log(`WeChat scan target: ${bridge.getCurrentPairing().url}`);
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startBridge().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
