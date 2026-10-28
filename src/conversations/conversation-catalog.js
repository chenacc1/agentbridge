import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const LIFECYCLES = new Set(["offline", "starting", "ready", "running", "failed", "closed"]);

function copy(record) {
  return record ? { ...record } : null;
}

function validTimestamp(value, fallback) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

export class ConversationCatalog {
  #items = new Map();
  #writes = Promise.resolve();
  #revision = 0;

  constructor({ filePath, now = () => new Date().toISOString() }) {
    this.filePath = filePath;
    this.now = now;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return this;
      throw Object.assign(new Error(`Conversation catalog could not be read: ${error.message}`), { cause: error });
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
      throw new Error("Conversation catalog has an unsupported schema");
    }
    this.#revision = Number.isSafeInteger(parsed.revision) ? parsed.revision : 0;
    let changed = false;
    for (const item of parsed.items) {
      const record = this.#validate(item);
      if (record.lifecycle !== "closed" && record.lifecycle !== "offline") {
        record.lifecycle = "offline";
        record.updatedAt = this.now();
        changed = true;
      }
      this.#items.set(record.id, record);
    }
    if (changed) {
      this.#revision += 1;
      await this.#persist();
    }
    return this;
  }

  get revision() {
    return this.#revision;
  }

  list() {
    return [...this.#items.values()]
      .map(copy)
      .sort((left, right) => (right.lastActiveAt ?? right.updatedAt).localeCompare(left.lastActiveAt ?? left.updatedAt));
  }

  get(id) {
    return copy(this.#items.get(id));
  }

  findByProvider(adapterId, providerConversationId) {
    if (!providerConversationId) return null;
    return copy([...this.#items.values()].find((record) => (
      record.adapterId === adapterId && record.providerConversationId === providerConversationId
    )));
  }

  async create(input) {
    const timestamp = this.now();
    const record = this.#validate({
      id: `bs_${randomUUID()}`,
      workspaceId: input.workspaceId ?? null,
      projectAlias: input.projectAlias,
      adapterId: input.adapterId,
      providerConversationId: input.providerConversationId ?? null,
      title: input.title,
      origin: input.origin ?? "phone-created",
      lifecycle: input.lifecycle ?? "starting",
      resumable: input.resumable === true,
      attached: input.attached === true,
      lastError: input.lastError ?? null,
      modelDirectory: input.modelDirectory ?? null,
      lastActiveAt: input.lastActiveAt ?? timestamp,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.#items.set(record.id, record);
    this.#revision += 1;
    await this.#persist();
    return copy(record);
  }

  async update(id, patch) {
    const current = this.#items.get(id);
    if (!current) return null;
    const record = this.#validate({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    });
    this.#items.set(id, record);
    this.#revision += 1;
    await this.#persist();
    return copy(record);
  }

  async mergeDiscovered({ workspaceId, projectAlias, adapterId, conversations, resumable = true }) {
    if (!Array.isArray(conversations)) throw new Error("Discovered conversations must be an array");
    const createdIds = [];
    const updatedIds = [];
    const merged = [];
    const providerIds = new Set();
    let changed = false;

    for (const conversation of conversations) {
      const providerConversationId = typeof conversation?.providerConversationId === "string"
        ? conversation.providerConversationId.slice(0, 200)
        : "";
      if (!providerConversationId || providerIds.has(providerConversationId)) continue;
      providerIds.add(providerConversationId);
      const existing = [...this.#items.values()].find((record) => (
        record.adapterId === adapterId && record.providerConversationId === providerConversationId
      ));
      const timestamp = this.now();
      const title = String(conversation.title || "Agent conversation").slice(0, 100);
      const discoveredLastActiveAt = validTimestamp(conversation.lastActiveAt, existing?.lastActiveAt ?? timestamp);

      if (!existing) {
        const record = this.#validate({
          id: `bs_${randomUUID()}`,
          workspaceId,
          projectAlias,
          adapterId,
          providerConversationId,
          title,
          origin: "provider-discovered",
          lifecycle: "offline",
          resumable,
          attached: false,
          lastError: null,
          lastActiveAt: discoveredLastActiveAt,
          createdAt: validTimestamp(conversation.createdAt, timestamp),
          updatedAt: timestamp,
        });
        this.#items.set(record.id, record);
        createdIds.push(record.id);
        merged.push(copy(record));
        changed = true;
        continue;
      }

      const lastActiveAt = discoveredLastActiveAt > existing.lastActiveAt
        ? discoveredLastActiveAt
        : existing.lastActiveAt;
      const nextTitle = existing.origin === "provider-discovered" ? title : existing.title;
      const needsUpdate = existing.workspaceId !== workspaceId
        || existing.projectAlias !== projectAlias
        || existing.resumable !== resumable
        || existing.lastActiveAt !== lastActiveAt
        || existing.title !== nextTitle;
      if (!needsUpdate) {
        merged.push(copy(existing));
        continue;
      }
      const record = this.#validate({
        ...existing,
        workspaceId,
        projectAlias,
        title: nextTitle,
        resumable,
        lastActiveAt,
        updatedAt: timestamp,
      });
      this.#items.set(record.id, record);
      updatedIds.push(record.id);
      merged.push(copy(record));
      changed = true;
    }

    if (changed) {
      this.#revision += 1;
      await this.#persist();
    }
    return { items: merged, createdIds, updatedIds };
  }

  #validate(input) {
    if (!input || typeof input.id !== "string" || !input.id.startsWith("bs_")) throw new Error("Conversation catalog contains an invalid id");
    if (typeof input.adapterId !== "string" || !input.adapterId) throw new Error("Conversation catalog contains an invalid adapter id");
    if (typeof input.projectAlias !== "string" || !input.projectAlias) throw new Error("Conversation catalog contains an invalid project alias");
    const lifecycle = LIFECYCLES.has(input.lifecycle) ? input.lifecycle : "offline";
    return {
      id: input.id,
      workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : null,
      projectAlias: input.projectAlias,
      adapterId: input.adapterId,
      providerConversationId: typeof input.providerConversationId === "string" ? input.providerConversationId : null,
      title: String(input.title || "Agent conversation").slice(0, 100),
      origin: String(input.origin || "phone-created").slice(0, 40),
      lifecycle,
      resumable: input.resumable === true,
      attached: input.attached === true,
      lastError: typeof input.lastError === "string" ? input.lastError.slice(-2000) : null,
      modelDirectory: this.#validateModelDirectory(input.modelDirectory),
      lastActiveAt: validTimestamp(input.lastActiveAt, validTimestamp(input.updatedAt, this.now())),
      createdAt: validTimestamp(input.createdAt, this.now()),
      updatedAt: validTimestamp(input.updatedAt, validTimestamp(input.createdAt, this.now())),
    };
  }

  // Persisted so a conversation whose Agent is offline still describes the model
  // it was last on. Shape check only: the session manager writes a compact form
  // and a hand-edited catalog must not be able to blow it up.
  #validateModelDirectory(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const groups = Array.isArray(value.groups) ? value.groups : [];
    const current = value.current && typeof value.current === "object" ? value.current : null;
    const failures = Array.isArray(value.failures) ? value.failures : [];
    if (!groups.length && !current && !failures.length) return null;
    return {
      current: current
        ? {
          provider: String(current.provider ?? "").slice(0, 100),
          model: String(current.model ?? "").slice(0, 160),
          ...(typeof current.reasoningEffort === "string" ? { reasoningEffort: current.reasoningEffort.slice(0, 100) } : {}),
        }
        : null,
      routable: value.routable === true,
      groups: groups.slice(0, 20).map((group) => ({
        id: String(group?.id ?? "").slice(0, 100),
        name: String(group?.name ?? group?.id ?? "").slice(0, 160),
        models: (Array.isArray(group?.models) ? group.models : []).slice(0, 40).map((model) => ({
          id: String(model?.id ?? "").slice(0, 160),
          name: String(model?.name ?? model?.id ?? "").slice(0, 160),
          ...(Array.isArray(model?.reasoning?.efforts) && model.reasoning.efforts.length
            ? { reasoning: { efforts: model.reasoning.efforts.slice(0, 8).map((effort) => ({
              id: String(effort?.id ?? "").slice(0, 100),
              name: String(effort?.name ?? effort?.id ?? "").slice(0, 160),
            })) } }
            : {}),
        })).filter((model) => model.id),
      })).filter((group) => group.id),
      failures: failures.slice(0, 5).map((failure) => ({
        id: String(failure?.id ?? "").slice(0, 100),
        name: String(failure?.name ?? failure?.id ?? "").slice(0, 160),
        message: String(failure?.message ?? "").slice(0, 300),
      })),
    };
  }

  #persist() {
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      revision: this.#revision,
      items: this.list(),
    });
    const operation = this.#writes.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      const handle = await open(temporaryPath, "w");
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
    });
    this.#writes = operation;
    return operation;
  }
}
