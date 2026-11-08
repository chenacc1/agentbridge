import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const name = "agentbridge-dsh-phone";
// `agents` is not optional: creating a conversation from the phone asks the agent
// service to open one, and touching a service that was not injected throws
// `cannot get property "agents" without inject` — which is what the phone showed
// as a failed "新建对话" instead of the friendly message below.
const inject = ["commands", "apiProxy", "llm", "agents"];
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";
const POLL_DELAY_MS = 800;
const EVENT_BATCH_DELAY_MS = 120;
const APPROVAL_PREFIX = "approval:";
// The bridge accepts at most 1 MB per /events POST (readJson limit), and this batch
// carries a JSON wrapper on top of the events. 448 KB leaves headroom, and it is also
// the cap for a single shrunken event, so one giant tool output can never wedge the
// queue behind a batch the bridge would refuse.
const EVENT_POST_BUDGET_BYTES = 448 * 1024;
const EVENT_MAX_ITEMS = 200;
const EVENT_EVENT_BUDGET_BYTES = 384 * 1024;
// A string longer than this in one event is clipped before it crosses the wire: the
// phone renders a summary of tool output, not a faithful copy, and a clipped giant is
// better than a batch that the bridge rejects.
const EVENT_STRING_CLIP = 2_048;
// Bumped whenever the integration gains something the phone relies on. The bridge
// compares it with the version it needs, because this file is *copied* into the DSH
// profile: changing the repository does nothing until install:dsh-phone runs again.
const INTEGRATION_VERSION = 6;
// Reconnect pacing. The first attempt is immediate (a bridge restart is usually already
// over by the time the next poll fails), then it backs off to `RECONNECT_MAX_MS`.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function textFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the bridge was simply not there.
 *
 * The distinction matters for the message the user sees: a refused connection
 * means the plugin loaded fine and only the local bridge is missing, which is a
 * setup step — while a 401 from a live bridge is a different problem entirely.
 */
function isBridgeAbsent(error) {
  const cause = error && typeof error === "object" ? error.cause?.code ?? "" : "";
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT|fetch failed|socket hang up/i
    .test(`${textFromError(error)} ${cause}`);
}

/** The setup steps a user needs when /phone finds nothing listening. */
function bridgeSetupText(origin) {
  return [
    `无法连接 AgentBridge 桥（${origin}）。插件本身已经加载，缺的是电脑上这个本地服务。`,
    "",
    "手动起桥只要一条命令：",
    "npx @chenacc/agentbridge",
    "",
    "想长期使用就装成全局命令：",
    "npm install -g @chenacc/agentbridge",
    "agentbridge phone --agent claude",
    "",
    `桥启动后再敲一次 /phone。桥不在默认端口的话，先设置环境变量 AGENTBRIDGE_ORIGIN，再重启 DSH Desktop。`,
  ].join("\n");
}

const BRIDGE_PACKAGE = "@chenacc/agentbridge";
// Long enough for a detached server to bind its port on a slow disk, short
// enough that /phone still reads as a command rather than a hang.
const AUTOSTART_TIMEOUT_MS = 8_000;

/**
 * Where the bridge's server entry lives on this machine, if it is installed.
 *
 * The plugin ships `@chenacc/agentbridge` as a dependency, so the normal answer
 * comes from module resolution next to this file. `AGENTBRIDGE_BRIDGE_ENTRY`
 * exists for tests and for unusual installs.
 *
 * Resolution goes through `createRequire` first on purpose: `import.meta.resolve`
 * only exists from Node 20.6, and the Electron runtime DSH Desktop loads plugins
 * in can be older than that — an unresolvable answer there fails silently and
 * looks exactly like "no bridge installed".
 *
 * The resolved manifest must live under a `node_modules` directory: without that
 * check, Node's package self-reference resolves this repository's own root
 * package as `@chenacc/agentbridge`, so a development checkout would start a
 * second bridge from the source tree and steal port 8787 from the developer.
 */
function bridgeServerEntry() {
  if (process.env.AGENTBRIDGE_BRIDGE_ENTRY) return process.env.AGENTBRIDGE_BRIDGE_ENTRY;

  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve(`${BRIDGE_PACKAGE}/package.json`));
  } catch {
    // Not installed next to the plugin: fall through to the ESM resolver.
  }
  try {
    if (typeof import.meta.resolve === "function") {
      candidates.push(fileURLToPath(import.meta.resolve(`${BRIDGE_PACKAGE}/package.json`)));
    }
  } catch {
    // No ESM resolver either: the dependency is simply absent.
  }

  for (const manifest of candidates) {
    if (!manifest.split(path.sep).includes("node_modules")) continue;
    const entry = path.join(path.dirname(manifest), "src", "server.js");
    if (existsSync(entry)) return entry;
  }
  return null;
}

async function bridgeIsReady(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Whether this process may start a bridge at all.
 *
 * A unit test must never spawn a server: node:test sets NODE_TEST_CONTEXT, and a
 * bridge started there would bind a real port and outlive the run. An explicit
 * AGENTBRIDGE_BRIDGE_ENTRY is the single way to opt back in, which is what the
 * autostart test relies on.
 */
function autoStartAllowed() {
  if (process.env.AGENTBRIDGE_NO_AUTOSTART === "1") return false;
  if (process.env.AGENTBRIDGE_BRIDGE_ENTRY) return true;
  return process.env.NODE_TEST_CONTEXT === undefined;
}

/**
 * Start the local bridge and wait until it answers.
 *
 * Returns true only once the health check passes, so the caller retries the real
 * registration instead of trusting that a spawn means a working server. Failures
 * stay quiet for the user (they get the manual steps either way) but each one is
 * reported through `log`, because "nothing happened" is the hardest thing to
 * diagnose from the outside.
 */
async function startBridge(origin, log = () => {}) {
  if (await bridgeIsReady(origin)) return true;
  if (!autoStartAllowed()) {
    log("auto-start disabled for this process");
    return false;
  }
  const entry = bridgeServerEntry();
  if (!entry || !existsSync(entry)) {
    log(`auto-start skipped: ${BRIDGE_PACKAGE} is not resolvable from the plugin install`);
    return false;
  }

  let port;
  try {
    port = new URL(origin).port || "8787";
  } catch {
    log(`auto-start skipped: ${origin} is not a usable origin`);
    return false;
  }

  try {
    // Loaded lazily: the plugin normally runs with a bridge already up, so the
    // child-process machinery is dead weight on the common path.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [entry], {
      // State gets its own directory: the bridge writes sessions, pairings and
      // logs under AGENTBRIDGE_DATA_DIR, and dropping that inside the DSH data
      // directory would mix two products' state in one place. The working
      // directory stays the user's home so the bridge's default project is not
      // some internal folder.
      cwd: homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        AGENTBRIDGE_PORT: process.env.AGENTBRIDGE_PORT || port,
        AGENTBRIDGE_DATA_DIR: process.env.AGENTBRIDGE_DATA_DIR || path.join(homedir(), ".agentbridge"),
      },
    });
    child.unref();
  } catch (error) {
    log(`auto-start failed to spawn ${entry}: ${textFromError(error)}`);
    return false;
  }

  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await bridgeIsReady(origin)) return true;
  }
  log(`auto-start timed out: spawned ${entry} but ${origin} never answered`);
  return false;
}

function clipped(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/**
 * Bound one event's wire size.
 *
 * The bridge rejects a batch over its limit, and a rejected batch is replayed whole
 * on the next flush — so an event that is too big by itself wedges the channel: the
 * same batch fails again and again, nothing ever advances, and the phone goes blind.
 * That loop is what used to fill the desktop log with `Request body is too large`.
 *
 * Clipping long strings keeps the event useful (the phone only ever shows a summary
 * of tool output); the last resort is a stub carrying just the type, because a queued
 * stub is progress while a queued giant is not.
 */
function shrinkEventForWire(event) {
  if (JSON.stringify(event).length <= EVENT_EVENT_BUDGET_BYTES) return event;
  const copy = { ...event };
  if (copy.data !== undefined && typeof copy.data === "object") copy.data = { ...copy.data };
  const clipStrings = (value, limit) => {
    if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[clipped]` : value;
    if (Array.isArray(value)) return value.map((item) => clipStrings(item, limit));
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = clipStrings(child, limit);
      return result;
    }
    return value;
  };
  copy.data = clipStrings(copy.data, EVENT_STRING_CLIP);
  if (JSON.stringify(copy).length <= EVENT_EVENT_BUDGET_BYTES) return copy;
  // Pathological: still over the budget after clipping. The phone only needs the
  // event's type to keep the transcript consistent; the payload is display-only.
  return { type: copy.type, time: copy.time, data: { note: "事件过大，手机侧省略了内容" } };
}

/**
 * Project one DSH mux frame onto the interaction record the bridge ingests.
 *
 * Only this session's frames matter, and only the four interaction payloads:
 * everything else on the stream is ordinary conversation traffic that already
 * travels on the event channel. Fields are copied out one by one because the
 * frame carries live DSH objects that must not be handed to another process.
 */
export function interactionRecord(envelope, sessionId) {
  const payload = envelope?.payload;
  const rpcId = typeof envelope?.rpcId === "string" ? envelope.rpcId : "";
  if (!payload || !rpcId || payload.sessionId !== sessionId) return null;
  if (payload.type === "question/requested") {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const projected = questions.slice(0, 10).flatMap((question, index) => {
      if (!question || typeof question !== "object") return [];
      const questionText = clipped(question.question, 4_000);
      if (!questionText) return [];
      const options = Array.isArray(question.options) ? question.options.slice(0, 25).flatMap((option) => {
        const label = clipped(option?.label, 200);
        if (!label) return [];
        const description = clipped(option?.description, 500);
        return [{ label, ...(description ? { description } : {}) }];
      }) : [];
      const header = clipped(question.header, 200);
      return [{
        id: clipped(question.id, 100) || `q${index + 1}`,
        question: questionText,
        ...(header ? { header } : {}),
        ...(options.length ? { options } : {}),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      }];
    });
    if (!projected.length) return null;
    return { kind: "question-requested", requestId: rpcId, questions: projected };
  }
  if (payload.type === "approval/requested") {
    return {
      kind: "approval-requested",
      requestId: rpcId,
      dshApprovalId: clipped(payload.approvalId, 200),
      toolName: clipped(payload.toolName, 200) || "tool",
      ...(payload.reason ? { reason: clipped(payload.reason, 2_000) } : {}),
      ...(payload.callId ? { callId: clipped(payload.callId, 200) } : {}),
    };
  }
  if (payload.type === "question/resolved") {
    return { kind: "question-resolved", requestId: clipped(payload.questionRpcId, 200), outcome: clipped(payload.outcome, 40) };
  }
  if (payload.type === "approval/resolved") {
    return {
      kind: "approval-resolved",
      requestId: "",
      dshApprovalId: clipped(payload.approvalId, 200),
      outcome: clipped(payload.outcome, 40),
    };
  }
  return null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function selectionFromAgent(agent) {
  let logged;
  try {
    logged = agent.session.requestHeader?.()?.config;
  } catch {
    logged = undefined;
  }
  const provider = agent.options?.provider || logged?.provider;
  const model = agent.options?.model || logged?.model;
  if (!provider || !model) return null;
  const reasoningEffort = agent.options?.reasoningEffort || logged?.reasoningEffort;
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function compactModelDirectory(value, current, extraFailures = []) {
  const groups = Array.isArray(value?.groups) ? value.groups.slice(0, 30).map((group) => ({
    id: group.id,
    name: group.name,
    models: Array.isArray(group.models) ? group.models.slice(0, 200).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.reasoning ? { reasoning: {
        efforts: Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts.slice(0, 20) : [],
        ...(model.reasoning.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}),
      } } : {}),
    })) : [],
  })) : [];
  const failures = [...extraFailures, ...(Array.isArray(value?.failures) ? value.failures : [])].slice(0, 30);
  return {
    current,
    routable: current ? groups.some((group) => group.id === current.provider) : false,
    groups,
    failures,
  };
}

async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The status matters to the caller: 401/403/404/409 mean "this channel no
    // longer exists", which is the signal to re-register instead of retrying.
    const error = new Error(body.error || `AgentBridge request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function isStaleChannel(error) {
  return [401, 403, 404, 409, 410].includes(Number(error?.status));
}

export class PhoneConnections {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.bySession = new Map();
    // One lifetime per conversation, independent of any single channel connection.
    // A reconnect tears the connection down (aborting its controller) *before* it knows
    // whether the bridge is back, so a retry loop tied to that controller could only
    // ever run one attempt — the exact bug that left a conversation dead after a manual
    // bridge restart. Only the desktop disposing the conversation ends a lifetime.
    this.lifetimes = new Map();
    this.reconnectMinMs = options.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    // Failed interaction cards survive a reconnect, so they are keyed to the
    // conversation, not to the channel that tried to carry them.
    this.interactionScopes = new Map();
    this.liveModelSelections = new WeakMap();
    this.ctx.on("session/event", (session, event) => this.captureEvent(session, event));
    this.ctx.on("agent/disposed", ({ agent }) => this.dispose(agent.session.id));
  }

  lifetimeFor(sessionId) {
    let lifetime = this.lifetimes.get(sessionId);
    if (!lifetime) {
      lifetime = new AbortController();
      this.lifetimes.set(sessionId, lifetime);
    }
    return lifetime;
  }

  async connect(agent, options = {}) {
    this.close(agent.session.id);
    const origin = String(process.env.AGENTBRIDGE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
    const modelDirectory = await this.modelDirectory(agent);
    // A conversation the phone asked for registers against the session it already
    // opened, so the bridge binds that one instead of minting a second pairing.
    const bridgeSessionId = typeof options.bridgeSessionId === "string" ? options.bridgeSessionId : "";
    // A reconnect must not consume a pairing code or add a device: the phone that
    // already owns this conversation keeps owning it.
    const reconnecting = options.reconnecting === true;
    const response = await fetch(`${origin}/api/local/dsh-desktop/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agent.session.id,
        cwd: agent.session.header.cwd,
        title: agent.session.header.title,
        provider: agent.options.provider,
        model: agent.options.model,
        modelDirectory,
        integrationVersion: INTEGRATION_VERSION,
        ...(bridgeSessionId ? { bridgeSessionId } : {}),
        ...(reconnecting ? { reconnect: true } : {}),
      }),
    });
    const registration = await readResponse(response);
    const state = {
      agent,
      origin,
      channel: registration.channel,
      controller: new AbortController(),
      lifetime: this.lifetimeFor(agent.session.id),
      cursor: 0,
      pendingEvents: [],
      phoneMessageIds: new Set(),
      // rpc ids this phone already answered, so DSH's own "resolved" echo is
      // not forwarded back and rendered as a second, duplicate resolution.
      answered: new Set(),
      eventTimer: null,
      flushing: false,
      retryPending: false,
    };
    this.bySession.set(agent.session.id, state);
    void this.poll(state);
    void this.watchInteractions(state);
    return registration;
  }

  /**
   * Re-register after the bridge forgot this channel.
   *
   * A bridge restart, a crash, or a replaced channel all look the same from here:
   * every call 401/404/409. Before this, that state was permanent — the only fix
   * was walking back to the computer and running /phone again — so the agent looks
   * dead from the phone while the desktop is perfectly healthy. Reconnecting keeps
   * the same DSH conversation and the same bridge session.
   *
   * There is deliberately no attempt cap. Stopping the bridge by hand (安全停止) and
   * starting it again is a human-scale pause that easily outlives a minute, and giving
   * up then left the conversation dead until someone walked back to the desktop. The
   * only bound is the interval, so a bridge that stays down is polled at most every
   * `RECONNECT_MAX_MS`, and disposing the conversation still stops the loop.
   */
  async ensureConnection(state) {
    const lifetime = state.lifetime ?? this.lifetimeFor(state.agent.session.id);
    if (lifetime.signal.aborted) return false;
    if (state.reconnecting) return state.reconnecting;
    state.reconnecting = (async () => {
      let delay = 0;
      let attempt = 0;
      while (!lifetime.signal.aborted) {
        // First attempt is immediate (a bridge restart is usually already over);
        // later ones back off so a permanently dead bridge is not hammered.
        if (delay > 0) await sleep(delay, lifetime.signal);
        delay = Math.min(Math.max(delay * 2, this.reconnectMinMs), this.reconnectMaxMs);
        if (lifetime.signal.aborted) return false;
        attempt += 1;
        try {
          await this.connect(state.agent, { reconnecting: true });
          this.ctx.logger.warn?.(`AgentBridge: reconnected "${state.agent.session.header.title ?? state.agent.session.id}" after the bridge forgot the channel (attempt ${attempt})`);
          return true;
        } catch (error) {
          // One line per attempt would bury the desktop log during a long outage.
          if (attempt === 1 || attempt % 10 === 0) {
            this.ctx.logger.warn?.(`AgentBridge reconnect attempt ${attempt} failed: ${textFromError(error)} (still retrying)`);
          }
        }
      }
      return false;
    })().finally(() => { state.reconnecting = null; });
    return state.reconnecting;
  }
  // Interaction retries live on the *lifetime*, not on the channel state. A reconnect
  // (or a dropped channel) throws the state away; a question that failed to cross the
  // wire must survive that, otherwise the phone sees the card a second after the
  // desktop — or not at all, which is the bug this queue removes.
  #interactionScope(sessionId) {
    let scope = this.interactionScopes.get(sessionId);
    if (!scope) {
      scope = { queue: [], draining: false };
      this.interactionScopes.set(sessionId, scope);
    }
    return scope;
  }

  // Questions and approvals never reach the session event log with an
  // answerable id, so they are read from DSH's own client stream and answered
  // through `apiProxy.respond`. Same seam the desktop window uses, which is what
  // lets a phone answer a question the desktop is also showing.
  async watchInteractions(state) {
    const events = this.ctx.apiProxy?.events;
    if (typeof events?.mux !== "function") return;
    const sessionId = state.agent.session.id;
    const scope = this.#interactionScope(sessionId);
    // Cards that failed before this channel existed are still owed to the phone.
    void this.#drainInteractions(state, scope, sessionId);
    try {
      for await (const envelope of events.mux({}, state.controller.signal)) {
        if (state.controller.signal.aborted) return;
        const record = interactionRecord(envelope, sessionId);
        if (!record) continue;
        if (this.#claimEcho(state, record)) continue;
        scope.queue.push(record);
        void this.#drainInteractions(state, scope, sessionId);
      }
    } catch (error) {
      if (state.controller.signal.aborted) return;
      if (isStaleChannel(error)) {
        await this.ensureConnection(state);
        return;
      }
      this.ctx.logger.warn(`AgentBridge interaction stream failed: ${textFromError(error)}`);
    }
  }

  async #drainInteractions(state, scope, sessionId) {
    if (scope.draining) return;
    scope.draining = true;
    try {
      while (scope.queue.length > 0) {
        // Always post through whatever channel owns the conversation right now:
        // a reconnect replaced `state`, and the new channel is the only one that
        // the bridge still knows.
        const current = this.bySession.get(sessionId);
        if (!current || current.controller.signal.aborted) return;
        try {
          await this.postInteractions(current, scope.queue[0]);
          scope.queue.shift();
        } catch (error) {
          if (this.bySession.get(sessionId) !== current) return; // replaced; the new drain takes over
          if (isStaleChannel(error)) {
            await this.ensureConnection(current);
            return; // the new state's watchInteractions drains this scope
          }
          // Keep the failed card at the head and retry it: losing it is the bug
          // this queue exists to remove.
          this.ctx.logger.warn(`AgentBridge interaction sync failed: ${textFromError(error)} (kept in the queue)`);
          await sleep(1_000, current.controller.signal);
        }
      }
    } finally {
      scope.draining = false;
      // A newer channel may have taken over while we were waiting; whoever owns
      // the conversation now finishes the queue.
      if (scope.queue.length > 0 && this.interactionScopes.has(sessionId)) {
        const current = this.bySession.get(sessionId);
        if (current) void this.#drainInteractions(current, scope, sessionId);
      }
    }
  }

  // Drop the resolution echo of an interaction this phone answered itself.
  #claimEcho(state, record) {
    if (record.kind === "question-resolved" && state.answered.has(record.requestId)) {
      state.answered.delete(record.requestId);
      return true;
    }
    if (record.kind === "approval-resolved" && state.answered.has(`${APPROVAL_PREFIX}${record.dshApprovalId}`)) {
      state.answered.delete(`${APPROVAL_PREFIX}${record.dshApprovalId}`);
      return true;
    }
    return false;
  }

  async postInteractions(state, record) {
    if (!state.channel.interactionsPath) return;
    const response = await fetch(`${state.origin}${state.channel.interactionsPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.channel.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ interactions: [record] }),
      signal: state.controller.signal,
    });
    await readResponse(response);
  }

  async respond(rpcId, result) {
    if (typeof this.ctx.apiProxy?.respond !== "function") throw new Error("This DSH Desktop build cannot answer questions from the phone");
    return await this.ctx.apiProxy.respond({ type: "client-response", rpcId, result });
  }

  async modelDirectory(agent) {
    const current = selectionFromAgent(agent);
    try {
      const response = await this.ctx.apiProxy.sessions.models({
        rpcId: randomUUID(),
        payload: { sessionId: agent.session.id },
      });
      const result = response?.result;
      if (!result?.ok) {
        if (result?.error?.code === "session-not-found") {
          return await this.hostModelDirectory(current, result.error.message);
        }
        throw new Error(result?.error?.message || "DSH Desktop did not provide its model directory");
      }
      return result.value;
    } catch (error) {
      return {
        current,
        routable: false,
        groups: [],
        failures: [{ id: "dsh-model-directory", name: "DSH Desktop", message: textFromError(error) }],
      };
    }
  }

  async hostModelDirectory(current, sessionError) {
    const response = await this.ctx.apiProxy.llm.models({ rpcId: randomUUID(), payload: {} });
    const result = response?.result;
    if (!result?.ok) throw new Error(result?.error?.message || "DSH Desktop did not provide its host model directory");
    return compactModelDirectory(result.value, current, [{
      id: "dsh-session-models",
      name: "DSH Desktop",
      message: `当前 UI 会话不在 session.models 注册表中，已改用 DSH 全局模型目录：${sessionError}`,
    }]);
  }

  liveModelSelection(agent) {
    const existing = this.liveModelSelections.get(agent);
    if (existing) return existing;
    const selection = { current: selectionFromAgent(agent), assembled: undefined };
    agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const selected = selection.current;
      const assembled = await next();
      selection.assembled = selected;
      if (!selected) return assembled;
      return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
    });
    agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      const selected = selection.assembled;
      if (!selected) return resolved;
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      };
    });
    this.liveModelSelections.set(agent, selection);
    return selection;
  }

  async selectModel(agent, requested) {
    const response = await this.ctx.apiProxy.sessions.selectModel({
      rpcId: randomUUID(),
      payload: { sessionId: agent.session.id, ...requested },
    });
    const result = response?.result;
    if (result?.ok) return result.value.selected;
    if (result?.error?.code !== "session-not-found") {
      throw new Error(result?.error?.message || "DSH Desktop rejected the model selection");
    }
    const resolved = await this.ctx.llm.resolveCallConfig(requested);
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
    };
    this.liveModelSelection(agent).current = selected;
    return selected;
  }

  async reportCommandResult(state, requestId, result) {
    const response = await fetch(`${state.origin}${state.channel.resultsPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.channel.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId, result }),
      signal: state.controller.signal,
    });
    await readResponse(response);
  }

  /**
   * Open a new conversation inside this desktop app and hand it to the phone.
   *
   * The conversation has to be a real DSH session, so it is created through the
   * agent service rather than faked in the bridge. Registering it against the
   * bridge session the phone already opened is what resolves the phone's create
   * call; if anything here fails the reason travels back as the command result.
   */
  async createSession(state, command) {
    try {
      // Read defensively: a build that does not inject `agents` throws on the bare
      // property access, and that raw Cordis error was all the phone ever saw. The
      // try/catch keeps the explanatory error reachable in that case too.
      let service = null;
      try {
        service = this.ctx.agents ?? null;
      } catch {
        service = null;
      }
      const create = typeof service?.create === "function" ? service.create.bind(service) : null;
      if (!create) throw new Error("这个 DSH Desktop 版本不支持从手机新建会话（缺少 ctx.agents.create）");
      const cwd = typeof command.cwd === "string" && command.cwd ? command.cwd : state.agent.session.header.cwd;
      if (!cwd) throw new Error("这个会话没有项目目录，无法新建");
      const sessionId = `session-${randomUUID()}`;
      const options = state.agent.options ?? {};
      const handle = await create({
        sessionId,
        meta: { cwd },
        ...(options.provider && options.model
          ? { agentOptions: { ...options, provider: options.provider, model: options.model } }
          : {}),
      });
      const agent = handle?.agent;
      if (!agent) throw new Error("DSH Desktop 没有返回新建的会话");
      await this.connect(agent, { bridgeSessionId: command.bridgeSessionId });
      await this.reportCommandResult(state, command.requestId, { ok: true, sessionId: agent.session.id });
    } catch (error) {
      await this.reportCommandResult(state, command.requestId, { ok: false, error: textFromError(error) }).catch(() => undefined);
    }
  }

  async answerQuestion(state, command) {
    const cancelled = command.kind === "cancel-question";
    const answers = Array.isArray(command.answers) ? command.answers : [];
    // Claim the rpc id before answering: DSH broadcasts `question/resolved`
    // while `respond()` is still settling, and the echo must not be forwarded
    // as a second resolution for this same card.
    state.answered.add(command.rpcId);
    try {
      const receipt = await this.respond(command.rpcId, cancelled
        ? { ok: false, error: { code: "cancelled", message: "the user skipped the question" } }
        : { ok: true, value: { sessionId: state.agent.session.id, answer: { answers } } });
      if (!receipt?.accepted) {
        state.answered.delete(command.rpcId);
        await this.reportCommandResult(state, command.requestId, {
          ok: false,
          error: `DSH Desktop did not accept this answer (${receipt?.reason ?? "unknown"})`,
        });
        return;
      }
      await this.reportCommandResult(state, command.requestId, { ok: true });
    } catch (error) {
      state.answered.delete(command.rpcId);
      await this.reportCommandResult(state, command.requestId, { ok: false, error: textFromError(error) });
    }
  }

  async answerApproval(state, command) {
    const key = `${APPROVAL_PREFIX}${command.dshApprovalId}`;
    state.answered.add(key);
    try {
      const receipt = await this.respond(command.rpcId, {
        ok: true,
        value: {
          sessionId: state.agent.session.id,
          approvalId: command.dshApprovalId,
          outcome: command.outcome === "allowed-once" ? "allowed-once" : "rejected",
        },
      });
      if (!receipt?.accepted) {
        state.answered.delete(key);
        await this.reportCommandResult(state, command.requestId, {
          ok: false,
          error: `DSH Desktop did not accept this decision (${receipt?.reason ?? "unknown"})`,
        });
        return;
      }
      await this.reportCommandResult(state, command.requestId, { ok: true });
    } catch (error) {
      state.answered.delete(key);
      await this.reportCommandResult(state, command.requestId, { ok: false, error: textFromError(error) });
    }
  }

  /** Tear the channel down; the conversation itself lives on (a reconnect reuses it). */
  close(sessionId) {
    const state = this.bySession.get(sessionId);
    if (!state) return;
    state.controller.abort();
    if (state.eventTimer) clearTimeout(state.eventTimer);
    this.bySession.delete(sessionId);
  }

  /** The desktop let go of the conversation: stop every loop, including reconnect. */
  dispose(sessionId) {
    this.lifetimes.get(sessionId)?.abort();
    this.lifetimes.delete(sessionId);
    // A disposed conversation can no longer answer its own questions, so the queue
    // that would deliver them goes with it.
    this.interactionScopes.delete(sessionId);
    this.close(sessionId);
  }

  captureEvent(session, event) {
    const state = this.bySession.get(session.id);
    if (!state || state.controller.signal.aborted) return;
    const origin = event.type === "user/message" && state.phoneMessageIds.delete(event.data?.id)
      ? "phone"
      : "desktop";
    // Shrink before queueing: a giant event wedges the channel if it reaches the
    // wire inside a rejected batch, and then every later flush replays it.
    state.pendingEvents.push({ event: shrinkEventForWire(event), origin });
    this.scheduleFlush(state);
  }

  // Only one batch may be in flight at a time. Overlapping flushes used to let a
  // newer batch overtake an older one, which reordered a turn's streamed text on
  // the phone and made the bridge treat the older batch as already seen.
  scheduleFlush(state) {
    if (state.flushing || state.retryPending || state.eventTimer || state.controller.signal.aborted) return;
    const delay = state.pendingEvents.length >= 50 ? 0 : EVENT_BATCH_DELAY_MS;
    state.eventTimer = setTimeout(() => {
      state.eventTimer = null;
      void this.flushEvents(state);
    }, delay);
  }

  async flushEvents(state) {
    if (state.flushing || state.retryPending || state.controller.signal.aborted || state.pendingEvents.length === 0) return;
    state.flushing = true;
    let failure = null;
    // One batch per POST, chosen by byte budget as well as item count: the bridge
    // refuses a whole batch that overruns its limit, and a rejected batch is replayed
    // in full on the next flush — so an oversized event wedged the channel behind
    // itself in an endless `Request body is too large` loop. Each item here was
    // already shrunk at capture time, so a batch under the budget always gets through.
    while (state.pendingEvents.length > 0 && !state.controller.signal.aborted && !failure) {
      const batch = [];
      let bytes = 12; // `{"events":[`
      for (let count = 0; count < EVENT_MAX_ITEMS && state.pendingEvents.length > 0; count += 1) {
        const item = state.pendingEvents.shift();
        const itemBytes = JSON.stringify(item).length + 1;
        if (bytes + itemBytes > EVENT_POST_BUDGET_BYTES && batch.length > 0) {
          state.pendingEvents.unshift(item);
          break;
        }
        batch.push(item);
        bytes += itemBytes;
      }
      // should not happen: items are shrunk at capture time; a lone item over the
      // budget would wedge the loop, so send it as-is and let the bridge's own cap
      // (1 MB, above the per-item budget) be the safety net.
      if (batch.length === 0) {
        batch.push(state.pendingEvents.shift());
      }
      let failed = null;
      try {
        const response = await fetch(`${state.origin}${state.channel.eventsPath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${state.channel.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ events: batch }),
          signal: state.controller.signal,
        });
        await readResponse(response);
      } catch (error) {
        failed = error;
        state.pendingEvents.unshift(...batch);
      }
      if (failed) {
        failure = failed;
        break;
      }
      if (state.controller.signal.aborted) break;
    }
    state.flushing = false;
    if (state.controller.signal.aborted) return;

    if (failure && isStaleChannel(failure)) {
      await this.ensureConnection(state);
      return;
    }
    if (failure) {
      this.ctx.logger.warn(`AgentBridge event sync failed: ${textFromError(failure)}`);
      // Hold everything back until the failed batch has been retried, so the
      // bridge never receives a newer batch ahead of an older one.
      state.retryPending = true;
      await sleep(1_000, state.controller.signal);
      state.retryPending = false;
      if (!state.controller.signal.aborted) void this.flushEvents(state);
      return;
    }
    if (state.pendingEvents.length) this.scheduleFlush(state);
  }

  async poll(state) {
    while (!state.controller.signal.aborted) {
      try {
        const response = await fetch(`${state.origin}${state.channel.pollPath}?after=${state.cursor}`, {
          headers: { authorization: `Bearer ${state.channel.token}` },
          signal: state.controller.signal,
        });
        const body = await readResponse(response);
        for (const command of body.commands || []) {
          if (command.kind === "message") {
            const message = createUserMessage(command.text);
            state.phoneMessageIds.add(message.id);
            state.agent.followup(message);
          } else if (command.kind === "cancel") {
            state.agent.cancel({ kind: "user" }, { keepInbox: true });
          } else if (command.kind === "select-model") {
            try {
              const selected = await this.selectModel(state.agent, {
                provider: command.selection?.provider,
                model: command.selection?.model,
                ...(command.selection?.reasoningEffort ? { reasoningEffort: command.selection.reasoningEffort } : {}),
              });
              await this.reportCommandResult(state, command.requestId, { ok: true, selected });
            } catch (error) {
              await this.reportCommandResult(state, command.requestId, { ok: false, error: textFromError(error) });
            }
          } else if (command.kind === "answer-question" || command.kind === "cancel-question") {
            await this.answerQuestion(state, command);
          } else if (command.kind === "create-session") {
            await this.createSession(state, command);
          } else if (command.kind === "answer-approval") {
            await this.answerApproval(state, command);
          }
          state.cursor = Math.max(state.cursor, command.seq);
        }
      } catch (error) {
        if (state.controller.signal.aborted) return;
        if (isStaleChannel(error)) {
          await this.ensureConnection(state);
          return;
        }
        this.ctx.logger.warn(`AgentBridge command polling failed: ${textFromError(error)}`);
      }
      await sleep(POLL_DELAY_MS, state.controller.signal);
    }
  }
}

function apply(ctx) {
  const connections = new PhoneConnections(ctx);
  ctx.commands.register({
    name: "phone",
    description: "pair this exact DSH Desktop conversation with a phone",
    recordInput: false,
    handler: async ({ agent }) => {
      if (!agent.session.header.cwd) {
        return { kind: "error", text: "当前会话没有项目目录，无法绑定手机。请先在项目文件夹中打开会话。" };
      }
      try {
        const registration = await connections.connect(agent);
        const model = [agent.options.provider, agent.options.model].filter(Boolean).join(" / ") || "当前 DSH 配置";
        return {
          kind: "success",
          text: [
            "手机接管二维码已生成（5 分钟内、仅可使用一次）：",
            `![AgentBridge 手机二维码](${registration.qrImageUrl})`,
            registration.pairing.url,
            `项目：${registration.project.cwd}`,
            `会话：${agent.session.id}`,
            `模型：${model}`,
          ].join("\n\n"),
        };
      } catch (error) {
        const origin = String(process.env.AGENTBRIDGE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
        return {
          kind: "error",
          text: isBridgeAbsent(error)
            ? bridgeSetupText(origin)
            : `无法连接 AgentBridge：${textFromError(error)}。请确认本机 ${origin} 正在运行。`,
        };
      }
    },
  });

  // Bring the bridge up in the background as soon as the plugin loads, so by the
  // time the user types /phone the local service is already there. Deliberately
  // not awaited: a slow spawn must never delay desktop startup, and the user
  // still gets the manual steps from /phone when nothing came up. The reason is
  // logged instead of swallowed, because "nothing happened" is undiagnosable.
  void startBridge(
    String(process.env.AGENTBRIDGE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, ""),
    (message) => ctx.logger?.warn?.(`[agentbridge-dsh-phone] ${message}`),
  ).catch((error) => ctx.logger?.warn?.(`[agentbridge-dsh-phone] auto-start crashed: ${textFromError(error)}`));
}

export { apply, inject, name };
