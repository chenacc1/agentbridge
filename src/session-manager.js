import { randomUUID } from "node:crypto";

function publicSession(session) {
  return {
    id: session.id,
    adapterId: session.adapterId,
    projectAlias: session.projectAlias,
    title: session.title,
    status: session.status,
    providerSessionId: session.handle?.providerSessionId ?? null,
    attached: Boolean(session.attached),
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    controller: session.controller ? {
      deviceId: session.controller.deviceId,
      deviceName: session.controller.deviceName,
      expiresAt: session.controller.expiresAt,
    } : null,
    modelDirectory: session.modelDirectory ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export class SessionManager {
  #sessions = new Map();
  #commands = new Map();
  #approvals = new Map();

  constructor({ eventStore, registry, projects, machineId = "local", controlTtlMs = 5 * 60_000 }) {
    this.eventStore = eventStore;
    this.registry = registry;
    this.projects = projects;
    this.machineId = machineId;
    this.controlTtlMs = controlTtlMs;
  }

  list() {
    return [...this.#sessions.values()].map(publicSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    return this.#sessions.get(id);
  }

  async create({ adapterId, projectAlias, title, commandId, device }) {
    return this.#idempotent(commandId, async () => {
      const adapter = this.registry.get(adapterId);
      if (!adapter) throw Object.assign(new Error("Unknown adapter"), { statusCode: 404 });
      const availability = await adapter.detect();
      if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
      if (availability.supported === false) throw Object.assign(new Error(availability.note ?? `${adapter.label} is not supported yet`), { statusCode: 501 });
      const cwd = this.projects.get(projectAlias);
      if (!cwd) throw Object.assign(new Error("Project alias is not allowed"), { statusCode: 403 });

      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        adapterId,
        adapter,
        projectAlias,
        title: String(title || `${adapter.label} session`).slice(0, 100),
        status: "starting",
        createdAt: now,
        updatedAt: now,
        controller: null,
        activeTurnId: null,
        lastError: null,
        handle: null,
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
        session.adapterId === adapterId && session.handle?.providerSessionId === providerSessionId
      ));
      if (existing) {
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
      if (typeof adapter.attach !== "function") {
        throw Object.assign(new Error(`${adapter.label} cannot attach an existing conversation`), { statusCode: 501 });
      }
      const availability = await adapter.detect();
      if (!availability.available) throw Object.assign(new Error(`${adapter.label} is not installed`), { statusCode: 409 });
      const cwd = this.projects.get(projectAlias);
      if (!cwd) throw Object.assign(new Error("Project alias is not allowed"), { statusCode: 403 });

      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        adapterId,
        adapter,
        projectAlias,
        title: String(title || `${adapter.label} attached conversation`).slice(0, 100),
        status: "starting",
        createdAt: now,
        updatedAt: now,
        controller: null,
        activeTurnId: null,
        lastError: null,
        handle: null,
        attached: true,
      };
      this.#sessions.set(session.id, session);
      this.#grant(session, device);
      await this.#emit(session, "session.created", { session: publicSession(session), attached: true });

      try {
        const emit = (kind, payload, extra = {}) => this.#emit(session, kind, payload, extra);
        session.handle = await adapter.attach({ cwd, projectAlias, bridgeSessionId: session.id, emit }, providerSessionId);
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

  async #emit(session, kind, payload, extra = {}) {
    session.updatedAt = new Date().toISOString();
    if (kind === "turn.started") {
      session.status = "running";
      session.activeTurnId = extra.turnId ?? null;
      session.lastError = null;
    } else if (["turn.completed", "turn.cancelled", "turn.failed"].includes(kind)) {
      session.status = kind === "turn.failed" ? "failed" : "ready";
      session.activeTurnId = null;
      session.lastError = kind === "turn.failed" ? String(payload.error ?? "Agent execution failed").slice(-2000) : null;
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
    return this.eventStore.append(kind, payload, {
      machineId: this.machineId,
      sessionId: session.id,
      turnId: extra.turnId ?? session.activeTurnId,
      actor: extra.actor ?? { type: "agent", adapter: session.adapterId },
    });
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
