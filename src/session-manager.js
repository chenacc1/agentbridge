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
    lastActiveAt: session.lastActiveAt ?? session.updatedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export class SessionManager {
  #sessions = new Map();
  #commands = new Map();
  #approvals = new Map();
  #deltas = new Map();

  constructor({
    eventStore,
    registry,
    projects,
    conversationCatalog = null,
    workspaceCatalog = null,
    machineId = "local",
    controlTtlMs = 5 * 60_000,
    deltaFlushMs = 120,
  }) {
    this.eventStore = eventStore;
    this.registry = registry;
    this.projects = projects;
    this.conversationCatalog = conversationCatalog;
    this.workspaceCatalog = workspaceCatalog;
    this.machineId = machineId;
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
        throw Object.assign(new Error(`${adapter.label} cannot create a new conversation`), {
          statusCode: 501,
          code: "ADAPTER_CAPABILITY_UNSUPPORTED",
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
        const emit = (kind, payload, extra = {}) => this.#emit(session, kind, payload, extra);
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
        this.#grant(existing, device);
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
      this.#grant(session, device);
      await this.#emit(session, "session.created", { session: publicSession(session), attached: true });

      try {
        const emit = (kind, payload, extra = {}) => this.#emit(session, kind, payload, extra);
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

  async send({ sessionId, text, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const session = this.#requireSession(sessionId);
      this.#requireControl(session, device);
      const cleanText = String(text ?? "").trim();
      if (!cleanText || cleanText.length > 20_000) {
        throw Object.assign(new Error("Message must contain 1 to 20000 characters"), { statusCode: 400 });
      }
      if (session.status === "running") throw Object.assign(new Error("A turn is already running"), { statusCode: 409 });
      await this.#ensureHandle(session);
      if (!session.handle) throw Object.assign(new Error("Session is not ready"), { statusCode: 409 });

      session.status = "running";
      session.updatedAt = new Date().toISOString();
      await this.#emit(session, "message.completed", { role: "user", text: cleanText }, {
        actor: { type: "user", deviceId: device.id, deviceName: device.deviceName },
      });
      const emit = (kind, payload, extra = {}) => this.#emit(session, kind, payload, extra);
      void Promise.resolve(session.adapter.send(session.handle, { text: cleanText, emit, commandId }))
        .catch((error) => this.#emit(session, "turn.failed", { error: error.message }));
      return { accepted: true, sessionId };
    });
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

  async #emit(session, kind, payload, extra = {}) {
    if (kind === "message.delta") return this.#queueDelta(session, payload, extra);
    // Any other event must land after the deltas that preceded it, or the phone
    // would render a completed message before its own streamed prefix.
    await this.#flushDelta(session.id);
    session.updatedAt = new Date().toISOString();
    session.lastActiveAt = session.updatedAt;
    if (kind === "turn.started") {
      session.status = "running";
      session.activeTurnId = extra.turnId ?? null;
      session.lastError = null;
    } else if (["turn.completed", "turn.cancelled", "turn.failed"].includes(kind)) {
      session.status = kind === "turn.failed" ? "failed" : "ready";
      session.activeTurnId = null;
      session.lastError = kind === "turn.failed" ? String(payload.error ?? "Agent execution failed").slice(-2000) : null;
      this.#deltas.delete(session.id);
    } else if (kind === "session.failed") {
      session.lastError = String(payload.error ?? "Agent session failed").slice(-2000);
    } else if (kind === "session.ready") {
      session.lastError = null;
    } else if (kind === "adapter.exited" && session.status !== "failed") {
      session.status = "offline";
      session.lastError = String(payload.error ?? payload.stderr ?? "Agent process exited").slice(-2000);
    } else if (kind === "approval.requested" && payload.approvalId) {
      this.#approvals.set(payload.approvalId, { sessionId: session.id });
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
      await this.#persistSession(session);
    }
    return this.eventStore.append(kind, payload, {
      machineId: this.machineId,
      sessionId: session.id,
      turnId: extra.turnId ?? session.activeTurnId,
      actor: extra.actor ?? { type: "agent", adapter: session.adapterId },
    });
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
      const emit = (kind, payload, extra = {}) => this.#emit(session, kind, payload, extra);
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

  #requireControl(session, device) {
    if (!session.controller || session.controller.expiresAt <= Date.now()) this.#grant(session, device);
    if (session.controller.deviceId !== device.id) {
      throw Object.assign(new Error(`Take control first; currently controlled by ${session.controller.deviceName}`), { statusCode: 409 });
    }
    session.controller.expiresAt = Date.now() + this.controlTtlMs;
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
