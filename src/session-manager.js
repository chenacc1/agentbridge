import { randomUUID } from "node:crypto";
import { adapterSupports } from "./adapters/capabilities.js";

function publicSession(session) {
  return {
    id: session.id,
    workspaceId: session.workspaceId ?? null,
    adapterId: session.adapterId,
    projectAlias: session.projectAlias,
    title: session.title,
    status: session.status,
    providerSessionId: session.providerSessionId ?? session.handle?.providerSessionId ?? null,
    attached: Boolean(session.attached),
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    controller: session.controller ? {
      deviceId: session.controller.deviceId,
      deviceName: session.controller.deviceName,
      expiresAt: session.controller.expiresAt,
    } : null,
    modelDirectory: session.modelDirectory ?? null,
    desktopConnected: desktopConnectedView(session),
    autoApprove: autoApproveView(session),
    usage: session.usage ?? { turns: 0, toolCalls: 0 },
    queued: session.queued ?? [],
    lastActiveAt: session.lastActiveAt ?? session.updatedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * Can the phone actually drive this session right now?
 *
 * A DSH Desktop conversation lives inside the desktop app, so it is only drivable
 * while that conversation's companion channel is connected. `null` means the
 * question does not apply (every other adapter owns its own process).
 */
function desktopConnectedView(session) {
  if (session?.adapterId !== "deepseek-harness-desktop") return null;
  const channels = session.adapter?.channels;
  if (typeof channels?.isOnline !== "function") return null;
  const providerSessionId = session.providerSessionId ?? session.handle?.providerSessionId ?? null;
  return channels.isOnline(providerSessionId) === true;
}

/** Expired policies must not leak into the UI as if they were still armed. */
function autoApproveView(session) {
  const policy = session?.autoApprove;
  if (!policy || policy.until <= Date.now()) return null;
  return { until: policy.until, tools: policy.tools, deviceName: policy.deviceName ?? null };
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "INPUT_ANSWER_INVALID" });
}

// A model directory is written into the conversation catalog on every ready
// event, so persistence keeps just enough to render the phone's model control
// after a restart: the current selection, provider and model names, and the
// reasoning efforts that selection can use. The live directory stays in memory.
// Only these five events are worth waking someone up for. Everything else is
// transcript traffic that the phone can pick up whenever it next opens.
// A time-boxed blanket approval is powerful enough to deserve hard limits: it can
// never outlive this window, whatever the client asks for.
const MAX_AUTO_APPROVE_MS = 30 * 60_000;

// A queue is a convenience, not a mailbox: five messages is already a lot to hold.
const MAX_QUEUED_MESSAGES = 5;

const NOTIFY_KINDS = new Set([
  "approval.requested",
  "input.requested",
  "turn.completed",
  "turn.failed",
  "session.failed",
]);
const STORED_MODEL_GROUPS = 20;
const STORED_MODELS_PER_GROUP = 40;
const STORED_EFFORTS_PER_MODEL = 8;

function compactModelDirectoryForStorage(directory) {
  if (!directory || typeof directory !== "object") return null;
  const groups = Array.isArray(directory.groups) ? directory.groups : [];
  const models = (group) => (Array.isArray(group?.models) ? group.models : []).slice(0, STORED_MODELS_PER_GROUP).map((model) => ({
    id: String(model?.id ?? "").slice(0, 160),
    name: String(model?.name ?? model?.id ?? "").slice(0, 160),
    ...(Array.isArray(model?.reasoning?.efforts) && model.reasoning.efforts.length
      ? { reasoning: { efforts: model.reasoning.efforts.slice(0, STORED_EFFORTS_PER_MODEL).map((effort) => ({
        id: String(effort?.id ?? "").slice(0, 100),
        name: String(effort?.name ?? effort?.id ?? "").slice(0, 160),
      })) } }
      : {}),
  })).filter((model) => model.id);
  const compact = {
    current: directory.current ?? null,
    routable: directory.routable === true,
    groups: groups.slice(0, STORED_MODEL_GROUPS).map((group) => ({
      id: String(group?.id ?? "").slice(0, 100),
      name: String(group?.name ?? group?.id ?? "").slice(0, 160),
      models: models(group),
    })).filter((group) => group.id),
    failures: (Array.isArray(directory.failures) ? directory.failures : []).slice(0, 5).map((failure) => ({
      id: String(failure?.id ?? "").slice(0, 100),
      name: String(failure?.name ?? failure?.id ?? "").slice(0, 160),
      message: String(failure?.message ?? "").slice(0, 300),
    })),
  };
  return compact.groups.length || compact.current || compact.failures.length ? compact : null;
}

// A phone that switches conversations re-reads this stream, so payload size is
// a direct latency cost. Measured on a real log: 3.09 MB of replay, of which 35%
// was `session.ready` repeating the whole model directory and 43% was raw tool
// arguments and tool output. Conversation text is never truncated.
const TOOL_COMMAND_LIMIT = 2_000;
const TOOL_TEXT_LIMIT = 4_000;
const STREAM_TEXT_LIMIT = 2_000;

function clampText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}… [已截断 ${value.length - limit} 字符]`;
}

/**
 * Shrink the payloads the phone only ever glances at.
 *
 * `session.ready` and `session.created` used to embed the entire public session
 * view, including the provider's model catalog (~43 KB each), on every attach;
 * `/api/state` is the one place that view belongs. Tool arguments and tool
 * output are shown as a single line on the phone, so a multi-kilobyte bash dump
 * bought nothing but bandwidth.
 */
export function compactEventPayload(kind, payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (kind === "tool.started") {
    return { ...payload, command: clampText(payload.command, TOOL_COMMAND_LIMIT) };
  }
  if (kind === "tool.completed") {
    return {
      ...payload,
      command: clampText(payload.command, TOOL_COMMAND_LIMIT),
      text: clampText(payload.text, TOOL_TEXT_LIMIT),
    };
  }
  if (kind === "adapter.output") {
    return { ...payload, text: clampText(payload.text, STREAM_TEXT_LIMIT) };
  }
  if (kind === "session.created" || kind === "session.ready") {
    const { session, ...rest } = payload;
    if (!session) return rest;
    return {
      ...rest,
      sessionId: session.id,
      adapterId: session.adapterId,
      title: session.title,
      status: session.status,
    };
  }
  return payload;
}

/**
 * Turn a phone answer batch into the exact shape the agent is waiting for.
 *
 * The provider matches an answer batch against its own pending request by
 * position and id, so the batch is rebuilt from the stored questions instead of
 * trusting the client's order or completeness. A question the phone skipped
 * still appears with an empty selection, which every provider accepts as "no
 * answer" while keeping the rest of the batch aligned.
 */
export function buildAnswerBatch(questions, answers) {
  if (!Array.isArray(answers)) throw badRequest("answers must be an array");
  const byId = new Map(questions.map((question) => [question.id, question]));
  const given = new Map();
  for (const answer of answers) {
    const id = String(answer?.id ?? "");
    const question = byId.get(id);
    if (!question) throw badRequest("This answer does not belong to the pending question");
    if (given.has(id)) throw badRequest("Each question may only be answered once");
    const selected = Array.isArray(answer.selected)
      ? [...new Set(answer.selected.map((label) => String(label).slice(0, 200)))]
      : [];
    const labels = new Set((question.options ?? []).map((option) => option.label));
    for (const label of selected) {
      if (!labels.has(label)) throw badRequest("The selected option is not one of this question's options");
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw badRequest("This question accepts a single option");
    }
    const trimmed = typeof answer.custom === "string" ? answer.custom.trim().slice(0, 4_000) : "";
    if (question.multiSelect !== true && trimmed && selected.length > 0) {
      throw badRequest("A single-choice question takes either an option or free text, not both");
    }
    given.set(id, { id, selected, ...(trimmed ? { custom: trimmed } : {}) });
  }
  return questions.map((question) => given.get(question.id) ?? { id: question.id, selected: [] });
}

export class SessionManager {
  #sessions = new Map();
  #commands = new Map();
  #approvals = new Map();
  #requests = new Map();
  #deltas = new Map();
  // Messages typed while a turn is running wait here instead of failing with 409.
  #queues = new Map();

  constructor({
    eventStore,
    registry,
    projects,
    conversationCatalog = null,
    workspaceCatalog = null,
    machineId = "local",
    controlTtlMs = 5 * 60_000,
    deltaFlushMs = 120,
    notifier = null,
    attachments = null,
  }) {
    this.eventStore = eventStore;
    this.registry = registry;
    this.projects = projects;
    this.conversationCatalog = conversationCatalog;
    this.workspaceCatalog = workspaceCatalog;
    this.machineId = machineId;
    this.notifier = notifier;
    this.attachments = attachments;
    this.controlTtlMs = controlTtlMs;
    this.deltaFlushMs = deltaFlushMs;
    for (const record of this.conversationCatalog?.list() ?? []) {
      this.#sessions.set(record.id, this.#sessionFromRecord(record));
    }
  }

  list({ workspaceId = null, adapterId = null } = {}) {
    return [...this.#sessions.values()]
      .filter((session) => !workspaceId || session.workspaceId === workspaceId)
      .filter((session) => !adapterId || session.adapterId === adapterId)
      .map(publicSession)
      .sort((a, b) => (b.lastActiveAt ?? b.updatedAt).localeCompare(a.lastActiveAt ?? a.updatedAt));
  }

  get(id) {
    return this.#sessions.get(id);
  }

  async shutdown() {
    const active = this.list().filter((session) => ["starting", "running", "stopping"].includes(session.status));
    if (active.length) {
      throw Object.assign(new Error("Stop active Agent turns before shutting down AgentBridge"), {
        statusCode: 409,
        code: "ACTIVE_SESSIONS",
        diagnostics: {
          count: active.length,
          sessions: active.map(({ id, title, status, adapterId }) => ({ id, title, status, adapterId })),
        },
      });
    }

    const failures = [];
    for (const session of this.#sessions.values()) {
      await this.#flushDelta(session.id);
      if (session.handle && typeof session.adapter?.dispose === "function") {
        try {
          await session.adapter.dispose(session.handle);
        } catch (error) {
          failures.push({ sessionId: session.id, error });
        }
      }
      session.handle = null;
      session.controller = null;
      if (session.status !== "closed") session.status = "offline";
      session.lastError = null;
      session.updatedAt = new Date().toISOString();
      await this.#persistSession(session);
    }

    if (failures.length) {
      throw new AggregateError(failures.map((item) => item.error), `Failed to dispose ${failures.length} Agent session(s)`);
    }
    return { stopped: true, sessions: this.#sessions.size };
  }

  async discover({ workspaceId, adapterId }) {
    const workspace = this.workspaceCatalog?.get(workspaceId);
    if (!workspace || !workspace.enabled) throw Object.assign(new Error("Workspace not found"), { statusCode: 404 });
    const adapter = this.registry.get(adapterId);
    if (!adapter) throw Object.assign(new Error("Unknown adapter"), { statusCode: 404 });
    if (!adapterSupports(adapter, "discover")) {
      throw Object.assign(new Error(`${adapter.label} cannot discover conversations`), {
        statusCode: 501,
        code: "ADAPTER_CAPABILITY_UNSUPPORTED",
      });
    }
    if (!this.conversationCatalog) {
      throw Object.assign(new Error("Conversation discovery requires the persistent catalog"), { statusCode: 501 });
    }
    const availability = await adapter.detect();
    if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
    if (availability.supported === false) {
      throw Object.assign(new Error(availability.note ?? `${adapter.label} is not supported yet`), { statusCode: 501 });
    }

    const result = await adapter.discoverConversations({ workspace });
    const conversations = Array.isArray(result) ? result : result?.conversations;
    if (!Array.isArray(conversations)) {
      throw Object.assign(new Error(`${adapter.label} returned an invalid discovery result`), {
        statusCode: 502,
        code: "ADAPTER_DISCOVERY_INVALID_RESPONSE",
      });
    }
    const merged = await this.conversationCatalog.mergeDiscovered({
      workspaceId: workspace.id,
      projectAlias: workspace.alias,
      adapterId,
      conversations,
      resumable: adapterSupports(adapter, "resume"),
    });
    for (const record of merged.items) {
      const existing = this.#sessions.get(record.id);
      if (existing) {
        existing.workspaceId = record.workspaceId;
        existing.projectAlias = record.projectAlias;
        existing.title = record.title;
        existing.lastActiveAt = record.lastActiveAt;
        existing.updatedAt = record.updatedAt;
      } else {
        this.#sessions.set(record.id, this.#sessionFromRecord(record));
      }
    }
    for (const id of merged.createdIds) {
      const session = this.#sessions.get(id);
      await this.eventStore.append("conversation.discovered", {
        conversation: publicSession(session),
        workspaceId: workspace.id,
        adapterId,
      }, {
        machineId: this.machineId,
        sessionId: id,
        actor: { type: "agent", adapter: adapterId },
      });
    }
    return {
      created: merged.createdIds.length,
      updated: merged.updatedIds.length,
      items: this.list({ workspaceId: workspace.id, adapterId }),
      diagnostics: Array.isArray(result) ? null : result?.diagnostics ?? null,
    };
  }

  async create({ adapterId, projectAlias, title, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const adapter = this.registry.get(adapterId);
      if (!adapter) throw Object.assign(new Error("Unknown adapter"), { statusCode: 404 });
      const availability = await adapter.detect();
      if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
      if (availability.supported === false) throw Object.assign(new Error(availability.note ?? `${adapter.label} is not supported yet`), { statusCode: 501 });
      if (!adapterSupports(adapter, "create")) {
        const { createReason } = adapter.capabilities ?? {};
        throw Object.assign(new Error(`${adapter.label} cannot create a new conversation${createReason ? `：${createReason}` : ""}`), {
          statusCode: 501,
          code: "ADAPTER_CAPABILITY_UNSUPPORTED",
          diagnostics: createReason ? { createReason } : undefined,
        });
      }
      const cwd = this.projects.get(projectAlias);
      if (!cwd) throw Object.assign(new Error("Project alias is not allowed"), { statusCode: 403 });

      const now = new Date().toISOString();
      const sessionTitle = String(title || `${adapter.label} session`).slice(0, 100);
      const workspace = this.workspaceCatalog?.get(projectAlias) ?? null;
      const catalogRecord = this.conversationCatalog
        ? await this.conversationCatalog.create({
          workspaceId: workspace?.id ?? null,
          projectAlias,
          adapterId,
          providerConversationId: null,
          title: sessionTitle,
          origin: "phone-created",
          lifecycle: "starting",
          resumable: adapterSupports(adapter, "resume"),
          attached: false,
        })
        : null;
      const session = {
        id: catalogRecord?.id ?? randomUUID(),
        workspaceId: workspace?.id ?? null,
        adapterId,
        adapter,
        projectAlias,
        title: sessionTitle,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        controller: null,
        activeTurnId: null,
        lastError: null,
        handle: null,
        providerSessionId: null,
      };
      this.#sessions.set(session.id, session);
      this.#grant(session, device);
      await this.#emit(session, "session.created", { session: publicSession(session) });

      try {
        const emit = (kind, payload, extra = {}) => this.#emitQuietly(session, kind, payload, extra);
        session.handle = await adapter.start({
          cwd,
          projectAlias,
          bridgeSessionId: session.id,
          emit,
        });
        session.providerSessionId = session.handle?.providerSessionId ?? null;
        session.modelDirectory = typeof adapter.modelDirectory === "function" ? adapter.modelDirectory(session.handle) : null;
        session.status = "ready";
        session.updatedAt = new Date().toISOString();
        await this.#emit(session, "session.ready", { session: publicSession(session) });
      } catch (error) {
        session.status = "failed";
        session.updatedAt = new Date().toISOString();
        await this.#emit(session, "session.failed", { error: error.message });
        throw error;
      }
      return publicSession(session);
    });
  }

  async attach({ adapterId, projectAlias, providerSessionId, title, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      if (typeof providerSessionId !== "string" || providerSessionId.length < 8 || providerSessionId.length > 200) {
        throw Object.assign(new Error("A valid provider session id is required"), { statusCode: 400 });
      }
      const existing = [...this.#sessions.values()].find((session) => (
        session.adapterId === adapterId && (session.providerSessionId ?? session.handle?.providerSessionId) === providerSessionId
      ));
      if (existing) {
        if (!existing.handle) await this.#ensureHandle(existing);
        existing.modelDirectory = typeof existing.adapter.modelDirectory === "function"
          ? existing.adapter.modelDirectory(existing.handle)
          : existing.modelDirectory ?? null;
        existing.status = "ready";
        existing.updatedAt = new Date().toISOString();
        // A reconnect arrives with no device: keep whoever holds the lease.
        if (device) this.#grant(existing, device);
        await this.#emit(existing, "session.ready", { session: publicSession(existing), attached: true, rebound: true });
        return publicSession(existing);
      }

      const adapter = this.registry.get(adapterId);
      if (!adapter) throw Object.assign(new Error("Unknown adapter"), { statusCode: 404 });
      if (!adapterSupports(adapter, "attach")) {
        throw Object.assign(new Error(`${adapter.label} cannot attach an existing conversation`), { statusCode: 501 });
      }
      const availability = await adapter.detect();
      if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
      const cwd = this.projects.get(projectAlias);
      if (!cwd) throw Object.assign(new Error("Project alias is not allowed"), { statusCode: 403 });

      const now = new Date().toISOString();
      const sessionTitle = String(title || `${adapter.label} attached conversation`).slice(0, 100);
      const workspace = this.workspaceCatalog?.get(projectAlias) ?? null;
      const catalogRecord = this.conversationCatalog
        ? await this.conversationCatalog.create({
          workspaceId: workspace?.id ?? null,
          projectAlias,
          adapterId,
          providerConversationId: providerSessionId,
          title: sessionTitle,
          origin: "desktop-attached",
          lifecycle: "starting",
          resumable: adapterSupports(adapter, "resume"),
          attached: true,
        })
        : null;
      const session = {
        id: catalogRecord?.id ?? randomUUID(),
        workspaceId: workspace?.id ?? null,
        adapterId,
        adapter,
        projectAlias,
        title: sessionTitle,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        controller: null,
        activeTurnId: null,
        lastError: null,
        handle: null,
        providerSessionId,
        attached: true,
      };
      this.#sessions.set(session.id, session);
      if (device) this.#grant(session, device);
      await this.#emit(session, "session.created", { session: publicSession(session), attached: true });

      try {
        const emit = (kind, payload, extra = {}) => this.#emitQuietly(session, kind, payload, extra);
        session.handle = await adapter.attach({ cwd, projectAlias, bridgeSessionId: session.id, emit }, providerSessionId);
        session.providerSessionId = session.handle?.providerSessionId ?? providerSessionId;
        session.modelDirectory = typeof adapter.modelDirectory === "function" ? adapter.modelDirectory(session.handle) : null;
        session.status = "ready";
        session.updatedAt = new Date().toISOString();
        await this.#emit(session, "session.ready", { session: publicSession(session), attached: true });
      } catch (error) {
        session.status = "failed";
        session.updatedAt = new Date().toISOString();
        await this.#emit(session, "session.failed", { error: error.message });
        throw error;
      }
      return publicSession(session);
    });
  }

  async send({ sessionId, text, attachments: attachmentIds = [], commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      this.#requireControl(session, device);
      const cleanText = String(text ?? "").trim();
      const attached = await this.#resolveAttachments(session, attachmentIds);
      // An image alone is a perfectly good message ("what is wrong here?").
      if ((!cleanText && !attached.length) || cleanText.length > 20_000) {
        throw Object.assign(new Error("消息需要文字或附件，且文字不超过 20000 字符"), { statusCode: 400 });
      }
      // A busy agent is not an error: the message waits its turn and the phone can
      // show the queue, which is how a person actually types while the agent works.
      if (session.status === "running") {
        const queue = this.#queueOf(session);
        if (queue.length >= MAX_QUEUED_MESSAGES) {
          throw Object.assign(new Error(`排队已满（${MAX_QUEUED_MESSAGES} 条），等这一轮结束后再发`), { statusCode: 429 });
        }
        const entry = {
          commandId,
          text: cleanText,
          attachments: attached,
          device: { id: device.id, deviceName: device.deviceName },
          at: Date.now(),
        };
        queue.push(entry);
        await this.#emit(session, "message.queued", {
          commandId,
          text: cleanText.slice(0, 200),
          position: queue.length,
          attachments: attached.map(({ id, name, mimeType, bytes, isImage }) => ({ id, name, mimeType, bytes, isImage })),
        }, { actor: { type: "user", deviceId: device.id, deviceName: device.deviceName } });
        return { queued: true, position: queue.length, sessionId };
      }
      await this.#dispatch(session, { text: cleanText, attachments: attached, device, commandId });
      return { accepted: true, sessionId };
    });
  }

  /**
   * Turn upload ids into something a provider can actually consume.
   *
   * Images arrive as base64 because every content-block protocol (Claude's
   * stream-json, ACP's prompt blocks) wants them inline; everything else is handed
   * over as an absolute path so an agent with file tools can open it itself. A
   * missing id is a client bug, not a silent drop.
   */
  async #resolveAttachments(session, ids) {
    const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id).slice(0, 6) : [];
    if (!list.length) return [];
    if (!this.attachments) throw Object.assign(new Error("This bridge cannot store attachments"), { statusCode: 501 });
    const resolved = [];
    for (const id of list) {
      const entry = this.attachments.get(id);
      if (!entry || entry.sessionId !== session.id) {
        throw Object.assign(new Error("附件不存在或不属于这个会话"), { statusCode: 404 });
      }
      const image = /^image\/(png|jpe?g|webp|gif)$/i.test(entry.mimeType);
      const inline = image && entry.bytes <= 5 * 1024 * 1024;
      const file = inline ? await this.attachments.read(id) : null;
      if (inline && !file) throw Object.assign(new Error("附件文件已丢失"), { statusCode: 404 });
      resolved.push({
        id: entry.id,
        name: entry.name,
        mimeType: entry.mimeType,
        bytes: entry.bytes,
        isImage: image,
        path: this.attachments.pathOf(id),
        ...(inline ? { dataBase64: file.data.toString("base64") } : {}),
      });
    }
    return resolved;
  }
  async stop({ sessionId, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      this.#requireControl(session, device);
      if (!adapterSupports(session.adapter, "cancel") || typeof session.adapter?.stop !== "function") {
        throw Object.assign(new Error(`${session.adapter?.label ?? "This Agent"} cannot stop an active turn`), {
          statusCode: 501,
          code: "ADAPTER_CAPABILITY_UNSUPPORTED",
        });
      }
      if (session.status !== "running" || !session.handle) {
        throw Object.assign(new Error("There is no active Agent turn to stop"), { statusCode: 409 });
      }
      const stopped = await session.adapter.stop(session.handle);
      await this.#emit(session, "turn.stop_requested", { stopped: Boolean(stopped) }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return { stopped: Boolean(stopped) };
    });
  }

  async selectModel({ sessionId, provider, model, reasoningEffort, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      this.#requireControl(session, device);
      if (session.status === "running") throw Object.assign(new Error("Wait for the current Agent turn to finish before changing models"), { statusCode: 409 });
      if (!session.handle || typeof session.adapter.selectModel !== "function") {
        throw Object.assign(new Error("This Agent session does not support changing models from AgentBridge"), { statusCode: 501 });
      }
      const selection = {
        provider: String(provider ?? "").slice(0, 100),
        model: String(model ?? "").slice(0, 160),
        ...(typeof reasoningEffort === "string" && reasoningEffort ? { reasoningEffort: reasoningEffort.slice(0, 100) } : {}),
      };
      if (!selection.provider || !selection.model) throw Object.assign(new Error("A provider and model are required"), { statusCode: 400 });
      const result = await session.adapter.selectModel(session.handle, selection);
      session.modelDirectory = typeof session.adapter.modelDirectory === "function" ? session.adapter.modelDirectory(session.handle) : session.modelDirectory;
      await this.#emit(session, "model.changed", { selected: result.selected }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return { selected: result.selected };
    });
  }

  async claimControl({ sessionId, commandId, device, force = false }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      const activeOther = session.controller
        && session.controller.expiresAt > Date.now()
        && session.controller.deviceId !== device.id;
      if (activeOther && !force) {
        throw Object.assign(new Error(`Controlled by ${session.controller.deviceName}`), { statusCode: 409 });
      }
      this.#grant(session, device);
      await this.#emit(session, "control.granted", { controller: publicSession(session).controller }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return publicSession(session).controller;
    });
  }

  async resolveApproval({ approvalId, decision, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      if (decision !== "approve" && decision !== "deny") {
        throw Object.assign(new Error("Decision must be approve or deny"), { statusCode: 400 });
      }
      const target = this.#approvals.get(approvalId);
      if (!target) throw Object.assign(new Error("Approval is missing or already resolved"), { statusCode: 409 });
      const session = this.#requireSession(target.sessionId);
      this.#requireControl(session, device);
      await session.adapter.resolveApproval(session.handle, approvalId, decision);
      this.#approvals.delete(approvalId);
      await this.#emit(session, "approval.resolved", { approvalId, decision }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return { approvalId, decision };
    });
  }

  /**
   * Grant a time-boxed blanket approval for this session.
   *
   * The phone should not have to babysit a long task, but a blanket approval is
   * also the most dangerous switch in the product: it is capped at 30 minutes,
   * scoped to an explicit tool list (`["*"]` for everything), owned by the device
   * that asked for it, and mirrored into the session so every client renders the
   * same countdown.
   */
  async setAutoApproval({ sessionId, minutes, tools = ["*"], commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      this.#requireControl(session, device);
      if (!adapterSupports(session.adapter, "approve")) {
        throw Object.assign(new Error(`${session.adapter?.label ?? "This Agent"} cannot approve tool calls`), {
          statusCode: 501,
          code: "ADAPTER_CAPABILITY_UNSUPPORTED",
        });
      }
      const requested = Number(minutes);
      if (!Number.isFinite(requested) || requested < 0) throw badRequest("minutes must be a number");
      if (requested === 0) {
        session.autoApprove = null;
        await this.#emit(session, "approval.policy", { autoApprove: null }, {
          actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
        });
        return { autoApprove: null };
      }
      const windowMs = Math.min(Math.round(requested * 60_000), MAX_AUTO_APPROVE_MS);
      if (windowMs < 60_000) throw badRequest("Ask for at least one minute, or 0 to turn it off");
      const scope = (Array.isArray(tools) ? tools : ["*"])
        .map((tool) => String(tool).trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 20);
      const policy = {
        until: Date.now() + windowMs,
        tools: scope.length ? scope : ["*"],
        by: device.id,
        deviceName: device.deviceName,
      };
      session.autoApprove = policy;
      await this.#emit(session, "approval.policy", { autoApprove: policy }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return { autoApprove: policy };
    });
  }

  /** The live policy for a session, or null once it has expired. */
  #liveAutoApprove(session) {
    const policy = session.autoApprove;
    if (!policy) return null;
    if (policy.until <= Date.now()) {
      session.autoApprove = null;
      return null;
    }
    return policy;
  }

  #autoApprovalAllows(session, payload) {
    const policy = this.#liveAutoApprove(session);
    if (!policy) return false;
    const tool = String(payload.request?.toolName ?? payload.method ?? "").slice(0, 60);
    return policy.tools.includes("*") || policy.tools.includes(tool);
  }

  async #autoResolveApproval(session, approvalId) {
    const policy = this.#liveAutoApprove(session);
    if (!policy) return;
    try {
      // Approvals are per tool call, so each one still goes through the adapter;
      // only the human decision is skipped.
      await session.adapter.resolveApproval(session.handle, approvalId, "approve");
      this.#approvals.delete(approvalId);
      await this.#emit(session, "approval.resolved", {
        approvalId,
        decision: "approve",
        auto: true,
        until: policy.until,
      }, { actor: { type: "system", source: "auto-approve" } });
    } catch (error) {
      // If the blanket approval could not be delivered, say so on the card instead
      // of leaving a phone waiting for a prompt that will never resolve.
      session.lastError = `自动放行失败：${error.message}`;
      await this.#emit(session, "approval.resolve_failed", { approvalId, error: String(error.message).slice(0, 500) });
    }
  }
  // An agent that pauses on a question is not running a turn the phone can stop
  // its way out of: the tool call is waiting on a human. This is the answer path
  // for `input.requested`, kept separate from `resolveApproval` because the
  // payload (option labels plus optional free text) and the provider seam differ.
  async resolveInput({ requestId, answers, cancel = false, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const target = this.#requests.get(String(requestId ?? ""));
      if (!target) throw Object.assign(new Error("This question is missing or already answered"), { statusCode: 409 });
      const session = this.#requireSession(target.sessionId);
      this.#requireControl(session, device);
      if (!adapterSupports(session.adapter, "answer") || typeof session.adapter?.resolveInput !== "function") {
        throw Object.assign(new Error(`${session.adapter?.label ?? "This Agent"} cannot answer questions from AgentBridge`), {
          statusCode: 501,
          code: "ADAPTER_CAPABILITY_UNSUPPORTED",
        });
      }
      const batch = cancel ? [] : buildAnswerBatch(target.questions, answers);
      await session.adapter.resolveInput(session.handle, requestId, { answers: batch, cancel: Boolean(cancel) });
      this.#requests.delete(requestId);
      const outcome = cancel ? "cancelled" : "answered";
      await this.#emit(session, "input.resolved", { requestId, outcome }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      return { requestId, outcome };
    });
  }

  // Agents emit one delta per token. Forwarding each one as its own stored
  // event floods the phone over a tunnel and lets token chatter push real
  // messages out of the replay window, so deltas are coalesced per turn and
  // addressed by character offset. A client folds them with
  // `text = current.slice(0, offset) + text`, which makes streaming idempotent
  // even when chunks are merged, replayed, or arrive out of order.
  #queueDelta(session, payload, extra) {
    const turnId = extra.turnId ?? session.activeTurnId ?? null;
    const text = String(payload?.text ?? "");
    if (!text) return;
    let state = this.#deltas.get(session.id);
    if (!state || state.turnId !== turnId) {
      state = { turnId, pending: "", offset: 0, timer: null, chain: Promise.resolve() };
      this.#deltas.set(session.id, state);
    }
    state.pending += text;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.#flushDelta(session.id).catch(() => undefined);
      }, this.deltaFlushMs);
      state.timer.unref?.();
    }
  }

  #flushDelta(sessionId) {
    const state = this.#deltas.get(sessionId);
    if (!state) return Promise.resolve();
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // Serialised per session so a turn's offsets are always emitted in order,
    // and so callers can await the last delta before a message.completed.
    state.chain = state.chain.catch(() => undefined).then(() => this.#writeDelta(sessionId));
    return state.chain;
  }

  async #writeDelta(sessionId) {
    const state = this.#deltas.get(sessionId);
    if (!state || !state.pending) return;
    const session = this.#sessions.get(sessionId);
    if (!session) {
      this.#deltas.delete(sessionId);
      return;
    }
    const text = state.pending;
    const offset = state.offset;
    state.pending = "";
    state.offset += text.length;
    await this.eventStore.append("message.delta", { role: "assistant", text, offset }, {
      machineId: this.machineId,
      sessionId,
      turnId: state.turnId,
      actor: { type: "agent", adapter: session.adapterId },
    });
  }

  // Adapters receive an `emit` closure and usually call it without awaiting it, so a
  // failure here (a full disk, a data directory that vanished) would otherwise become an
  // unhandled rejection and kill the whole bridge mid-turn. Losing one event is bad;
  // taking every other conversation down with it is worse.
  #emitQuietly(session, kind, payload, extra = {}) {
    return this.#emit(session, kind, payload, extra).catch((error) => {
      console.error(`AgentBridge dropped ${kind} for session ${session.id}: ${error?.message ?? error}`);
      return null;
    });
  }

  async #emit(session, kind, payload, extra = {}) {
    if (kind === "message.delta") return this.#queueDelta(session, payload, extra);
    // Any other event must land after the deltas that preceded it, or the phone
    // would render a completed message before its own streamed prefix.
    await this.#flushDelta(session.id);
    session.updatedAt = new Date().toISOString();
    session.lastActiveAt = session.updatedAt;
    if (kind === "tool.started") {
      this.#countUsage(session, { toolCalls: 1 });
    }
    if (kind === "turn.started") {
      session.status = "running";
      session.activeTurnId = extra.turnId ?? null;
      session.lastError = null;
    } else if (["turn.completed", "turn.cancelled", "turn.failed"].includes(kind)) {
      this.#countUsage(session, {
        turns: 1,
        ...(Number.isFinite(payload.usage?.inputTokens) ? { inputTokens: payload.usage.inputTokens } : {}),
        ...(Number.isFinite(payload.usage?.outputTokens) ? { outputTokens: payload.usage.outputTokens } : {}),
      });
      session.status = kind === "turn.failed" ? "failed" : "ready";
      session.activeTurnId = null;
      session.lastError = kind === "turn.failed" ? String(payload.error ?? "Agent execution failed").slice(-2000) : null;
      this.#deltas.delete(session.id);
      this.#dropRequests(session.id);
    } else if (kind === "session.failed") {
      session.lastError = String(payload.error ?? "Agent session failed").slice(-2000);
    } else if (kind === "session.ready") {
      session.lastError = null;
    } else if (kind === "adapter.exited" && session.status !== "failed") {
      session.status = "offline";
      session.lastError = String(payload.error ?? payload.stderr ?? "Agent process exited").slice(-2000);
      this.#dropRequests(session.id);
    } else if (kind === "approval.requested" && payload.approvalId) {
      this.#approvals.set(payload.approvalId, { sessionId: session.id });
      // A live policy answers this one instead of the phone, so the agent never
      // stalls on a prompt nobody is looking at.
      if (this.#autoApprovalAllows(session, payload)) void this.#autoResolveApproval(session, payload.approvalId);
    } else if (kind === "approval.resolved" && payload.approvalId) {
      this.#approvals.delete(payload.approvalId);
    } else if (kind === "input.requested" && payload.requestId) {
      this.#requests.set(payload.requestId, {
        sessionId: session.id,
        questions: Array.isArray(payload.questions) ? payload.questions : [],
      });
    } else if (kind === "input.resolved" && payload.requestId) {
      this.#requests.delete(payload.requestId);
    }
    if ([
      "session.ready",
      "session.failed",
      "turn.started",
      "turn.completed",
      "turn.cancelled",
      "turn.failed",
      "adapter.exited",
    ].includes(kind)) {
      // The catalog is an index, not the conversation: a failed write must never
      // take the bridge down. Several call sites emit fire-and-forget, so a rejection
      // here surfaces as an unhandled rejection and kills the process mid-turn.
      await this.#persistSession(session).catch((error) => {
        console.error(`AgentBridge catalog write failed for session ${session.id}: ${error?.message ?? error}`);
      });
    }
    session.queued = this.queuedMessages(session.id);
    const appended = await this.eventStore.append(kind, compactEventPayload(kind, payload), {
      machineId: this.machineId,
      sessionId: session.id,
      turnId: extra.turnId ?? session.activeTurnId,
      actor: extra.actor ?? { type: "agent", adapter: session.adapterId },
    });
    // Fire and forget: a notification must never delay or fail the event it
    // describes, and the notifier's own rate limit keeps a long turn from storming
    // the user's chat.
    if (this.notifier?.enabled) void this.#notify(session, kind, payload);
    // A finished turn is the moment a queued message can go out.
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(kind)) {
      void this.#drainQueue(session).catch(() => undefined);
    }
    return appended;
  }

  #notify(session, kind, payload) {
    if (!NOTIFY_KINDS.has(kind)) return;
    return this.#notificationContext(session)
      .then((context) => this.notifier.send(kind, payload, context))
      .catch(() => undefined);
  }

  async #notificationContext(session) {
    return {
      sessionId: session.id,
      sessionTitle: session.title,
      adapterId: session.adapterId,
      adapterLabel: session.adapter?.label ?? session.adapterId,
      machineName: this.machineName,
      lastAssistantText: await this.#lastAssistantText(session),
    };
  }

  /** The tail of the newest assistant message, for a notification preview. */
  async #lastAssistantText(session) {
    if (typeof this.eventStore.readSessionHistory !== "function") return "";
    const history = await this.eventStore.readSessionHistory(session.id, { limit: 12 });
    const events = Array.isArray(history?.events) ? history.events : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind !== "message.completed") continue;
      if (event.payload?.role !== "assistant") continue;
      const text = String(event.payload.text ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }

  async #ensureHandle(session) {
    if (session.handle) return session.handle;
    const adapter = session.adapter ?? this.registry.get(session.adapterId);
    if (!adapter) throw Object.assign(new Error("Session adapter is unavailable"), { statusCode: 409 });
    if (!session.providerSessionId || !adapterSupports(adapter, "attach") || !adapterSupports(adapter, "resume")) {
      throw Object.assign(new Error(`${adapter.label} cannot resume this conversation`), {
        statusCode: 501,
        code: "ADAPTER_CAPABILITY_UNSUPPORTED",
      });
    }
    const availability = await adapter.detect();
    if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
    if (availability.supported === false) {
      throw Object.assign(new Error(availability.note ?? `${adapter.label} is not supported yet`), { statusCode: 501 });
    }
    const cwd = this.projects.get(session.projectAlias);
    if (!cwd) throw Object.assign(new Error("Project alias is not allowed"), { statusCode: 403 });

    session.adapter = adapter;
    session.status = "starting";
    session.updatedAt = new Date().toISOString();
    await this.#persistSession(session);
    try {
      const emit = (kind, payload, extra = {}) => this.#emitQuietly(session, kind, payload, extra);
      session.handle = await adapter.attach({
        cwd,
        projectAlias: session.projectAlias,
        bridgeSessionId: session.id,
        emit,
      }, session.providerSessionId);
      session.providerSessionId = session.handle?.providerSessionId ?? session.providerSessionId;
      session.modelDirectory = typeof adapter.modelDirectory === "function" ? adapter.modelDirectory(session.handle) : null;
      session.status = "ready";
      session.updatedAt = new Date().toISOString();
      await this.#emit(session, "session.ready", { session: publicSession(session), resumed: true });
      return session.handle;
    } catch (error) {
      session.status = "failed";
      session.lastError = error.message;
      session.updatedAt = new Date().toISOString();
      await this.#emit(session, "session.failed", { error: error.message, resumed: true });
      throw error;
    }
  }

  #persistSession(session) {
    if (!this.conversationCatalog?.get(session.id)) return Promise.resolve();
    return this.conversationCatalog.update(session.id, {
      providerConversationId: session.providerSessionId ?? session.handle?.providerSessionId ?? null,
      title: session.title,
      lifecycle: session.status,
      resumable: adapterSupports(session.adapter, "resume"),
      attached: Boolean(session.attached),
      lastError: session.lastError ?? null,
      lastActiveAt: session.lastActiveAt ?? session.updatedAt,
      // Without this the phone hides the model control of every conversation
      // whose Agent is offline, which read as "the feature disappeared".
      modelDirectory: compactModelDirectoryForStorage(session.modelDirectory),
    });
  }

  #sessionFromRecord(record) {
    return {
      id: record.id,
      workspaceId: record.workspaceId ?? null,
      adapterId: record.adapterId,
      adapter: this.registry.get(record.adapterId) ?? null,
      projectAlias: record.projectAlias,
      title: record.title,
      status: record.lifecycle === "closed" ? "closed" : "offline",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActiveAt: record.lastActiveAt ?? record.updatedAt,
      controller: null,
      activeTurnId: null,
      lastError: record.lastError,
      handle: null,
      providerSessionId: record.providerConversationId,
      attached: record.attached,
      modelDirectory: record.modelDirectory ?? null,
    };
  }

  #requireSession(id) {
    const session = this.#sessions.get(id);
    if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return session;
  }

  #grant(session, device) {
    session.controller = {
      deviceId: device.id,
      deviceName: device.deviceName,
      expiresAt: Date.now() + this.controlTtlMs,
    };
  }

  /**
   * Actually start a turn. Shared by `send` and by the queue drain, because both
   * have to produce exactly the same events.
   */
  async #dispatch(session, { text, attachments = [], device, commandId }) {
    await this.#ensureHandle(session);
    if (!session.handle) throw Object.assign(new Error("Session is not ready"), { statusCode: 409 });
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    await this.#emit(session, "message.completed", {
      role: "user",
      text,
      ...(attachments.length
        ? { attachments: attachments.map(({ id, name, mimeType, bytes, isImage }) => ({ id, name, mimeType, bytes, isImage })) }
        : {}),
    }, {
      actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
    });
    const emit = (kind, payload, extra = {}) => this.#emitQuietly(session, kind, payload, extra);
    void Promise.resolve(session.adapter.send(session.handle, { text, attachments, emit, commandId }))
      .catch((error) => this.#emitQuietly(session, "turn.failed", { error: error.message }));
  }

  /**
   * Activity counters, and token totals when the Agent reports them.
   *
   * Every provider exposes something different: Claude puts token counts on its
   * result frame, others report nothing. Turns and tool calls are always counted
   * (they are what "how much has this done" means in practice); tokens are added only
   * when an adapter actually knows them.
   */
  #countUsage(session, delta = {}) {
    const usage = session.usage ?? { turns: 0, toolCalls: 0 };
    for (const key of ["turns", "toolCalls", "inputTokens", "outputTokens"]) {
      if (Number.isFinite(delta[key])) usage[key] = (usage[key] ?? 0) + delta[key];
    }
    session.usage = usage;
  }
  #queueOf(session) {
    let queue = this.#queues.get(session.id);
    if (!queue) {
      queue = [];
      this.#queues.set(session.id, queue);
    }
    return queue;
  }

  /** Public view of the queue, so every client renders the same list. */
  queuedMessages(sessionId) {
    return (this.#queues.get(sessionId) ?? []).map((entry, index) => ({
      commandId: entry.commandId,
      text: entry.text.slice(0, 200),
      position: index + 1,
      at: entry.at,
      attachments: (entry.attachments ?? []).map(({ id, name, isImage }) => ({ id, name, isImage })),
    }));
  }

  /** Send the next queued message once the current turn is over. */
  async #drainQueue(session) {
    const queue = this.#queues.get(session.id);
    if (!queue?.length) return;
    if (session.status === "running") return;
    const next = queue.shift();
    try {
      await this.#emit(session, "message.dequeued", { commandId: next.commandId, remaining: queue.length }, {
        actor: { type: "user", deviceId: next.device.id, deviceName: next.device.deviceName },
      });
      await this.#dispatch(session, {
        text: next.text,
        attachments: next.attachments ?? [],
        device: next.device,
        commandId: next.commandId,
      });
    } catch (error) {
      session.status = "failed";
      session.lastError = `排队消息发送失败：${error.message}`;
      await this.#emit(session, "turn.failed", { error: session.lastError });
    }
  }

  /** Drop a queued message before it is sent. */
  async cancelQueued({ sessionId, commandId, device, force = false }) {
    const session = this.#requireSession(sessionId);
    if (!force) this.#requireControl(session, device);
    const queue = this.#queues.get(session.id) ?? [];
    const index = queue.findIndex((entry) => entry.commandId === commandId);
    if (index < 0) throw Object.assign(new Error("这条排队消息已经不存在"), { statusCode: 404 });
    const [removed] = queue.splice(index, 1);
    await this.#emit(session, "message.dequeued", {
      commandId: removed.commandId,
      cancelled: true,
      remaining: queue.length,
    }, { actor: { type: "user", deviceId: device.id, deviceName: device.deviceName } });
    return { cancelled: true, remaining: queue.length };
  }
  /** Route-level guard for endpoints that live outside this class (uploads). */
  requireControlFor(sessionId, device) {
    this.#requireControl(this.#requireSession(sessionId), device);
  }

  #requireControl(session, device) {
    if (!session.controller || session.controller.expiresAt <= Date.now()) this.#grant(session, device);
    if (session.controller.deviceId !== device.id) {
      // The code lets the phone recover without string-matching: tapping 提交回答 is
      // an explicit decision to drive, so it claims the lease and retries once.
      throw Object.assign(
        new Error(`这个会话现在由「${session.controller.deviceName}」控制：先接管输入再继续`),
        { statusCode: 409, code: "CONTROL_REQUIRED" },
      );
    }
    session.controller.expiresAt = Date.now() + this.controlTtlMs;
  }

  // A question only lives as long as the turn that asked it: once the run ends,
  // answering it would be a 409 anyway, so the entry goes with it.
  #dropRequests(sessionId) {
    for (const [requestId, request] of this.#requests) {
      if (request.sessionId === sessionId) this.#requests.delete(requestId);
    }
  }

  #idempotent(commandId, operation) {
    if (typeof commandId !== "string" || commandId.length < 8 || commandId.length > 100) {
      throw Object.assign(new Error("A valid commandId is required"), { statusCode: 400 });
    }
    if (this.#commands.has(commandId)) return this.#commands.get(commandId);
    const result = Promise.resolve().then(operation);
    this.#commands.set(commandId, result);
    if (this.#commands.size > 2000) this.#commands.delete(this.#commands.keys().next().value);
    return result;
  }
}
