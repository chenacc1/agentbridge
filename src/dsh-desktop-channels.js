import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function tokenDigest(token) {
  return createHash("sha256").update(String(token)).digest();
}

function normalizeAfter(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeSelection(value) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider ?? "").slice(0, 100);
  const model = String(value.model ?? "").slice(0, 160);
  if (!provider || !model) return null;
  const reasoningEffort = typeof value.reasoningEffort === "string" ? value.reasoningEffort.slice(0, 100) : undefined;
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function normalizeModelDirectory(value) {
  if (!value || typeof value !== "object") return null;
  const current = normalizeSelection(value.current);
  const groups = Array.isArray(value.groups) ? value.groups.slice(0, 30).flatMap((group) => {
    if (!group || typeof group !== "object") return [];
    const id = String(group.id ?? "").slice(0, 100);
    if (!id) return [];
    const models = Array.isArray(group.models) ? group.models.slice(0, 200).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = String(entry.id ?? "").slice(0, 160);
      if (!model) return [];
      const reasoning = entry.reasoning && typeof entry.reasoning === "object"
        ? { efforts: Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts.slice(0, 20).flatMap((effort) => {
          const id = String(effort?.id ?? "").slice(0, 100);
          return id ? [{ id, name: String(effort?.name ?? id).slice(0, 160) }] : [];
        }) : [] }
        : undefined;
      return [{ id: model, name: String(entry.name ?? model).slice(0, 160), ...(reasoning ? { reasoning } : {}) }];
    }) : [];
    return [{ id, name: String(group.name ?? id).slice(0, 160), models }];
  }) : [];
  const failures = Array.isArray(value.failures) ? value.failures.slice(0, 30).flatMap((failure) => {
    const id = String(failure?.id ?? "").slice(0, 100);
    return id ? [{ id, name: String(failure?.name ?? id).slice(0, 160), message: String(failure?.message ?? "Unknown error").slice(0, 500) }] : [];
  }) : [];
  if (!current && groups.length === 0 && failures.length === 0) return null;
  return { current, routable: value.routable === true, groups, failures };
}

export class DshDesktopChannelManager {
  #byProvider = new Map();
  #byChannel = new Map();

  register({ providerSessionId, cwd, title, provider, model, modelDirectory }) {
    let state = this.#byProvider.get(providerSessionId);
    if (!state) {
      state = {
        providerSessionId,
        commands: [],
        nextCommandSeq: 0,
        lastDshEventSeq: 0,
        bridge: null,
      };
      this.#byProvider.set(providerSessionId, state);
    } else if (state.channelId) {
      this.#byChannel.delete(state.channelId);
      for (const pending of state.requests?.values() ?? []) {
        clearTimeout(pending.timer);
        pending.reject(httpError("DSH Desktop /phone connection was replaced", 409));
      }
      state.requests?.clear();
    }

    const token = randomBytes(32).toString("base64url");
    state.channelId = randomUUID();
    state.tokenDigest = tokenDigest(token);
    state.cwd = cwd;
    state.title = title || null;
    state.provider = provider || null;
    state.model = model || null;
    state.modelDirectory = normalizeModelDirectory(modelDirectory);
    state.commands = [];
    state.nextCommandSeq = 0;
    state.registeredAt = Date.now();
    state.lastSeenAt = Date.now();
    state.closed = false;
    this.#byChannel.set(state.channelId, state);

    return {
      id: state.channelId,
      token,
      providerSessionId,
      registeredAt: state.registeredAt,
    };
  }

  revoke(channelId) {
    const state = this.#byChannel.get(channelId);
    if (!state) return false;
    this.#byChannel.delete(channelId);
    if (state.channelId === channelId) {
      state.closed = true;
      state.channelId = null;
      for (const pending of state.requests?.values() ?? []) {
        clearTimeout(pending.timer);
        pending.reject(httpError("DSH Desktop /phone connection was closed", 409));
      }
      state.requests?.clear();
    }
    return true;
  }

  attachBridge(providerSessionId, bridge) {
    const state = this.#byProvider.get(providerSessionId);
    if (!state || state.closed) throw httpError("DSH Desktop companion is not registered", 409);
    state.bridge = bridge;
    return state;
  }

  metadata(providerSessionId) {
    const state = this.#byProvider.get(providerSessionId);
    if (!state) return null;
    return {
      cwd: state.cwd,
      title: state.title,
      provider: state.provider,
      model: state.model,
      modelDirectory: state.modelDirectory,
      lastSeenAt: state.lastSeenAt,
    };
  }

  enqueue(providerSessionId, command) {
    const state = this.#byProvider.get(providerSessionId);
    if (!state || state.closed || !state.channelId) {
      throw httpError("DSH Desktop /phone connection is offline; run /phone again in that conversation", 409);
    }
    const queued = {
      seq: ++state.nextCommandSeq,
      ...command,
    };
    state.commands.push(queued);
    if (state.commands.length > 500) state.commands.shift();
    return queued;
  }

  request(providerSessionId, command, timeoutMs = 15_000) {
    const state = this.#byProvider.get(providerSessionId);
    if (!state || state.closed || !state.channelId) {
      throw httpError("DSH Desktop /phone connection is offline; run /phone again in that conversation", 409);
    }
    const requestId = randomUUID();
    const queued = this.enqueue(providerSessionId, { ...command, requestId });
    if (!state.requests) state.requests = new Map();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.requests?.delete(requestId);
        reject(httpError("DSH Desktop did not confirm the model change in time", 504));
      }, timeoutMs);
      state.requests.set(requestId, { resolve, reject, timer, command: queued });
    });
  }

  complete(channelId, token, requestId, result) {
    const state = this.#authenticate(channelId, token);
    const pending = state.requests?.get(requestId);
    if (!pending) throw httpError("Unknown or expired DSH Desktop request", 409);
    clearTimeout(pending.timer);
    state.requests.delete(requestId);
    state.lastSeenAt = Date.now();
    if (!result?.ok) {
      pending.reject(httpError(String(result?.error ?? "DSH Desktop rejected the model change").slice(0, 500), 409));
      return { accepted: true };
    }
    const selected = normalizeSelection(result.selected);
    if (pending.command.kind !== "select-model" || !selected) {
      pending.reject(httpError("Invalid DSH Desktop model response", 502));
      return { accepted: true };
    }
    if (state.modelDirectory) state.modelDirectory.current = selected;
    state.provider = selected.provider;
    state.model = selected.model;
    pending.resolve({ selected });
    return { accepted: true };
  }

  poll(channelId, token, after) {
    const state = this.#authenticate(channelId, token);
    const cursor = normalizeAfter(after);
    state.lastSeenAt = Date.now();
    state.commands = state.commands.filter((command) => command.seq > cursor);
    return {
      commands: state.commands.slice(0, 100),
      lastSeenAt: state.lastSeenAt,
    };
  }

  async ingest(channelId, token, records) {
    const state = this.#authenticate(channelId, token);
    if (!Array.isArray(records) || records.length > 200) {
      throw httpError("events must be an array containing at most 200 items", 400);
    }
    if (!state.bridge?.onEvent) throw httpError("Bridge session is not ready", 409);
    state.lastSeenAt = Date.now();

    let accepted = 0;
    for (const record of records) {
      const event = record?.event;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= state.lastDshEventSeq) continue;
      if (typeof event.type !== "string" || typeof event.time !== "number" || !event.data) {
        throw httpError("Invalid DSH session event", 400);
      }
      await state.bridge.onEvent({ event, origin: record.origin === "phone" ? "phone" : "desktop" }, state);
      state.lastDshEventSeq = event.seq;
      accepted += 1;
    }
    return { accepted, lastEventSeq: state.lastDshEventSeq };
  }

  #authenticate(channelId, token) {
    const state = this.#byChannel.get(channelId);
    if (!state || state.closed || typeof token !== "string") throw httpError("Invalid DSH Desktop channel", 401);
    const supplied = tokenDigest(token);
    if (supplied.length !== state.tokenDigest.length || !timingSafeEqual(supplied, state.tokenDigest)) {
      throw httpError("Invalid DSH Desktop channel", 401);
    }
    return state;
  }
}
