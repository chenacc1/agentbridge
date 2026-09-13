import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
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

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(sourceDir, "../public");

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
  json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
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

async function registerLocalProject(projects, requestedPath) {
  if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) {
    throw Object.assign(new Error("cwd must be an absolute local path"), { statusCode: 400 });
  }
  let cwd;
  try {
    cwd = await realpath(requestedPath);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw Object.assign(new Error("cwd must be an existing directory"), { statusCode: 400 });
  }
  const comparable = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  for (const [alias, projectPath] of projects) {
    const existing = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
    if (existing === comparable) return { alias, cwd };
  }
  const slug = path.basename(cwd).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 22) || "project";
  const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  const alias = `local-${slug}-${suffix}`.slice(0, 40);
  projects.set(alias, cwd);
  return { alias, cwd };
}

async function serveStatic(res, pathname) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/pair": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
    "/command-id.js": ["command-id.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  };
  const target = files[pathname];
  if (!target) return false;
  const content = await readFile(path.join(publicDir, target[0]));
  res.writeHead(200, {
    "content-type": target[1],
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(content);
  return true;
}

export async function createBridge(options = {}) {
  const config = options.config ?? loadConfig();
  const eventStore = options.eventStore ?? new EventStore({ filePath: path.join(config.dataDir, "events.jsonl") });
  await eventStore.init();
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
  const sessions = options.sessions ?? new SessionManager({ eventStore, registry, projects: config.projects });
  let currentPairing = pairing.createPairing(config.advertisedOrigin);
  const dshQrTargets = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, lastSeq: eventStore.lastSeq });
      }

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
        const body = await readJson(req, 512 * 1024);
        return json(res, 202, await dshDesktopChannels.ingest(localMatch[1], requestToken(req), body.events));
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
          "set-cookie": sessionCookie(local.token, config.secureCookies, config.sessionTtlMs),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/local/phone") {
        if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error("Local access only"), { statusCode: 403 });
        requireSameOrigin(req);
        const body = await readJson(req);
        const project = await registerLocalProject(config.projects, body.cwd);
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
        const project = await registerLocalProject(config.projects, body.cwd);
        const title = String(body.title || `${path.basename(project.cwd)} · DSH Desktop`).slice(0, 100);
        const registration = dshDesktopChannels.register({
          providerSessionId,
          cwd: project.cwd,
          title,
          provider: String(body.provider || "").slice(0, 100),
          model: String(body.model || "").slice(0, 160),
          modelDirectory: body.modelDirectory,
        });
        const device = pairing.createSession("DSH Desktop /phone");
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
          channel: {
            id: registration.id,
            token: registration.token,
            pollPath: `/api/local/dsh-desktop/channels/${registration.id}/poll`,
            eventsPath: `/api/local/dsh-desktop/channels/${registration.id}/events`,
            resultsPath: `/api/local/dsh-desktop/channels/${registration.id}/results`,
          },
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
      if (req.method === "GET" && await serveStatic(res, url.pathname)) return;

      requireAccessKey(req, url, config);
      const device = pairing.authenticate(requestToken(req));
      if (!device) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });

      if (req.method === "GET" && url.pathname === "/api/devices") {
        return json(res, 200, { devices: pairing.listDevices(), currentDeviceId: device.id });
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, 200, {
          machine: { id: "local", name: config.machineName },
          device,
          projects: [...config.projects.keys()],
          adapters: await registry.describe(),
          sessions: sessions.list(),
          lastSeq: eventStore.lastSeq,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/recent-session") {
        requireSameOrigin(req);
        const body = await readJson(req);
        const sessionId = String(body.sessionId ?? "");
        if (!sessions.get(sessionId)) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
        pairing.setLastSession(device.id, sessionId);
        return json(res, 200, { resumeSessionId: sessionId });
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? "0", 10) || 0);
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
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/))) {
        const targetId = decodeURIComponent(match[1]);
        if (!pairing.revoke(targetId)) throw Object.assign(new Error("Device not found"), { statusCode: 404 });
        const headers = targetId === device.id
          ? { "set-cookie": `agentbridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.secureCookies ? "; Secure" : ""}` }
          : {};
        return json(res, 200, { revoked: true }, headers);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readJson(req);
        const session = await sessions.create({ ...body, device });
        return json(res, 201, { session });
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
        const body = await readJson(req);
        return json(res, 202, await sessions.send({ sessionId: match[1], ...body, device }));
      }
      if (req.method === "POST" && (match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/))) {
        const body = await readJson(req);
        return json(res, 200, await sessions.selectModel({ sessionId: match[1], ...body, device }));
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
      json(res, 404, { error: "Not found" });
    } catch (error) {
      if (!Number.isInteger(error.statusCode) || error.statusCode >= 500) console.error(error);
      if (!res.headersSent) errorResponse(res, error);
      else res.end();
    }
  });

  return { server, config, eventStore, pairing, registry, sessions, dshDesktopChannels, getCurrentPairing: () => currentPairing };
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
