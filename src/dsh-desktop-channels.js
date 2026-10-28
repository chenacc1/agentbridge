import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Applied sequence numbers are remembered so replaying a batch is a no-op.
const MAX_APPLIED_SEQ = 20_000;

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
  // Pending "create a conversation in the desktop app" requests, keyed by the
  // bridge session id the phone already opened. The desktop companion answers by
  // registering that new conversation, which is what resolves the entry.
  #creates = new Map();
  #createRequests = new Map();

  /**
   * Is any DSH Desktop conversation currently paired?
   *
   * Creating a conversation from the phone has to happen inside the desktop app,
   * so the capability is only real while a companion is polling.
   */
  hasOnlineChannel() {
    for (const state of this.#byProvider.values()) {
      if (state.channelId && !state.closed) return true;
    }
    return false;
  }

  /**
   * Is *this* conversation's companion connected right now?
   *
   * A DSH Desktop conversation only exists inside the desktop app, so without its
   * channel there is nothing to drive. The phone needs to know that before it offers
   * an input box, rather than after the user has typed into it.
   */
  isOnline(providerSessionId) {
    if (typeof providerSessionId !== "string" || !providerSessionId) return false;
    const state = this.#byProvider.get(providerSessionId);
    return Boolean(state && !state.closed && state.channelId);
  }

  /**
   * Ask a paired desktop conversation to open a new conversation in `cwd`.
   *
   * Resolves with the new provider session id once the companion registers it,
   * so the caller can bind the bridge session it already created. The request
   * rides an existing channel: the companion owns its own DSH context and can
   * create conversations independently of which one is paired.
   */
  requestSession({ cwd, title, bridgeSessionId, timeoutMs = 45_000 }) {
    if (typeof bridgeSessionId !== "string" || !bridgeSessionId) {
      throw httpError("A bridge session id is required to create a DSH Desktop conversation", 400);
    }
    let carrier = null;
    for (const state of this.#byProvider.values()) {
      if (state.channelId && !state.closed) {
        if (!carrier || state.lastSeenAt > carrier.lastSeenAt) carrier = state;
      }
    }
    if (!carrier) {
      throw httpError("DSH Desktop 桌面端离线：请先在 DSH Desktop 的对话里运行 /phone，再回来新建", 409);
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#creates.delete(bridgeSessionId);
        this.#createRequests.delete(requestId);
        reject(httpError("DSH Desktop 没能在超时前创建会话", 504));
      }, timeoutMs);
      this.#creates.set(bridgeSessionId, { resolve, reject, timer, requestId, cwd });
      this.#createRequests.set(requestId, bridgeSessionId);
      this.enqueue(carrier.providerSessionId, {
        kind: "create-session",
        requestId,
        bridgeSessionId,
        cwd,
        ...(title ? { title } : {}),
      });
    });
  }

  /** The companion registered the conversation it just created. */
  settleCreate(bridgeSessionId, value) {
    const pending = this.#creates.get(bridgeSessionId);
    if (!pending) return false;
    this.#creates.delete(bridgeSessionId);
    this.#createRequests.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    return true;
  }

  /** The companion gave up: surface its reason instead of waiting for the timeout. */
  failCreate(bridgeSessionId, message) {
    const pending = this.#creates.get(bridgeSessionId);
    if (!pending) return false;
    this.#creates.delete(bridgeSessionId);
    this.#createRequests.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.reject(httpError(String(message ?? "DSH Desktop 创建会话失败").slice(0, 500), 409));
    return true;
  }

  /** A create result arrives on the carrier channel, not on the session it creates. */
  #completeCreate(requestId, result) {
    const bridgeSessionId = this.#createRequests.get(requestId);
    if (!bridgeSessionId) return false;
    if (result?.ok) {
      // Success is completed by the registration of the new conversation, which
      // carries the provider session id the bridge has to bind.
      return true;
    }
    this.#createRequests.delete(requestId);
    this.failCreate(bridgeSessionId, result?.error);
    return true;
  }

  register({ providerSessionId, cwd, title, provider, model, modelDirectory, integrationVersion = 0 }) {
    let state = this.#byProvider.get(providerSessionId);
    if (!state) {
      state = {
        providerSessionId,
        commands: [],
        nextCommandSeq: 0,
        lastDshEventSeq: 0,
        appliedSeq: new Set(),
        ingestChain: Promise.resolve(),
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
    state.integrationVersion = Number.isSafeInteger(integrationVersion) ? integrationVersion : 0;
    state.commands = [];
    state.nextCommandSeq = 0;
    state.registeredAt = Date.now();
    state.lastSeenAt = Date.now();
    state.closed = false;
    if (!state.appliedSeq) state.appliedSeq = new Set();
    if (!state.ingestChain) state.ingestChain = Promise.resolve();
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
    // This is what the phone used to read as "DSH Desktop companion is not registered",
    // which said nothing about what to do. A DSH Desktop conversation is driven through
    // the desktop app, so the one action that fixes it is running /phone there — and the
    // companion reconnects by itself once it is running the current integration.
    if (!state || state.closed) {
      throw httpError("桌面端没有连上这个会话：请在这台电脑的 DSH Desktop 里打开该会话并执行 /phone（桌面端已在运行的话，几秒后会自动接回）", 409);
    }
    state.bridge = bridge;
    return state;
  }
  /**
   * What the paired companions reported about themselves.
   *
   * `stale` means a desktop is running an older copy of the integration than this
   * bridge expects — the fix is `npm run install:dsh-phone` plus a DSH restart, which
   * is worth telling the user before they debug a missing feature.
   */
  integrationStatus({ required = 5 } = {}) {
    const versions = [];
    for (const state of this.#byProvider.values()) {
      if (state.channelId && !state.closed && Number.isSafeInteger(state.integrationVersion)) {
        versions.push(state.integrationVersion);
      }
    }
    if (!versions.length) return { paired: false, version: null, required, stale: false };
    const version = Math.min(...versions);
    return { paired: true, version, required, stale: version < required };
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
      throw httpError("桌面端这个会话还没连上：请在这台电脑的 DSH Desktop 里打开该会话执行 /phone", 409);
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
      throw httpError("桌面端这个会话还没连上：请在这台电脑的 DSH Desktop 里打开该会话执行 /phone", 409);
    }
    const requestId = randomUUID();
    const queued = this.enqueue(providerSessionId, { ...command, requestId });
    if (!state.requests) state.requests = new Map();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.requests?.delete(requestId);
        const what = command.kind === "select-model" ? "the model change" : "your answer";
        reject(httpError(`DSH Desktop did not confirm ${what} in time`, 504));
      }, timeoutMs);
      state.requests.set(requestId, { resolve, reject, timer, command: queued });
    });
  }

  complete(channelId, token, requestId, result) {
    const state = this.#authenticate(channelId, token);
    state.lastSeenAt = Date.now();
    if (!state.requests?.has(requestId) && this.#completeCreate(requestId, result)) {
      // A create request is answered on the carrier channel while the session it
      // creates belongs to another one; only a failure is meaningful here.
      return { accepted: true };
    }
    const pending = state.requests?.get(requestId);
    if (!pending) throw httpError("Unknown or expired DSH Desktop request", 409);
    clearTimeout(pending.timer);
    state.requests.delete(requestId);
    if (!result?.ok) {
      pending.reject(httpError(String(result?.error ?? "DSH Desktop rejected the request").slice(0, 500), 409));
      return { accepted: true };
    }
    if (pending.command.kind !== "select-model") {
      // Answers to a question or an approval are confirmed only in the sense
      // that the desktop accepted them; there is no value to fold back in.
      pending.resolve({ accepted: true });
      return { accepted: true };
    }
    const selected = normalizeSelection(result.selected);
    if (!selected) {
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
    // Batches are applied strictly one at a time. Concurrent flushes from the
    // desktop companion used to interleave, which reordered a turn's streamed
    // text and let each batch's cursor mark another batch's events as seen.
    const run = state.ingestChain.catch(() => undefined).then(() => this.#applyRecords(state, records));
    state.ingestChain = run;
    return run;
  }

  /**
   * Deliver human-interaction frames (questions and approvals) from the desktop
   * companion.
   *
   * These are not session events: DSH mints a fresh rpc id for each pending
   * interaction, and that id is not part of the durable log, so they travel on
   * their own channel instead of sharing the seq-deduplicated event stream.
   */
  async ingestInteractions(channelId, token, interactions) {
    const state = this.#authenticate(channelId, token);
    if (!Array.isArray(interactions) || interactions.length > 50) {
      throw httpError("interactions must be an array containing at most 50 items", 400);
    }
    if (!state.bridge?.onInteraction) throw httpError("Bridge session is not ready", 409);
    state.lastSeenAt = Date.now();
    let handled = 0;
    for (const interaction of interactions) {
      if (!interaction || typeof interaction.kind !== "string" || typeof interaction.requestId !== "string") continue;
      if (!interaction.requestId) continue;
      await state.bridge.onInteraction(interaction);
      handled += 1;
    }
    return { handled };
  }

  async #applyRecords(state, records) {
    const pending = [];
    for (const record of records) {
      const event = record?.event;
      if (!event || !Number.isSafeInteger(event.seq)) continue;
      if (typeof event.type !== "string" || typeof event.time !== "number" || !event.data) {
        throw httpError("Invalid DSH session event", 400);
      }
      // Dedupe by the exact sequence numbers already applied rather than by a
      // high-water mark, so a batch that arrives late or is retried after a
      // newer one is still accepted instead of being silently discarded.
      if (state.appliedSeq.has(event.seq)) continue;
      pending.push({ event, origin: record.origin === "phone" ? "phone" : "desktop" });
    }
    pending.sort((a, b) => a.event.seq - b.event.seq);

    let accepted = 0;
    for (const record of pending) {
      await state.bridge.onEvent(record, state);
      state.appliedSeq.add(record.event.seq);
      state.lastDshEventSeq = Math.max(state.lastDshEventSeq, record.event.seq);
      accepted += 1;
    }
    if (state.appliedSeq.size > MAX_APPLIED_SEQ) {
      const cutoff = state.lastDshEventSeq - Math.floor(MAX_APPLIED_SEQ / 2);
      for (const seq of state.appliedSeq) if (seq < cutoff) state.appliedSeq.delete(seq);
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
