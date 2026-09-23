import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// The log is append-only and grows without bound, so startup reads a bounded
// tail. It is still compacted while scanning, because applying the window to raw
// log lines would let an on-disk delta flood truncate the conversation again.
const MAX_INIT_BYTES = 16 * 1024 * 1024;

function deltaKey(event) {
  return `${event.sessionId ?? ""}\u0000${event.turnId ?? ""}`;
}

// Streaming deltas are progress, not history. Keeping every token in the
// replay window is what previously pushed real conversation out of it: a single
// long turn could emit thousands of message.delta events, so a phone that
// reconnected only ever received the token tail of the newest turn instead of
// the messages. `retain` therefore keeps at most one delta per turn, merging
// later chunks into it so a reconnecting client still receives the whole
// in-progress text.
function retain(events, deltaByTurn, event) {
  if (event.kind !== "message.delta") {
    events.push(event);
    return;
  }
  const key = deltaKey(event);
  const previous = deltaByTurn.get(key);
  if (previous) {
    const index = events.indexOf(previous);
    if (index >= 0) events.splice(index, 1);
    const payload = event.payload ?? {};
    event.payload = {
      ...payload,
      text: `${previous.payload?.text ?? ""}${payload.text ?? ""}`,
      offset: previous.payload?.offset ?? 0,
    };
  }
  events.push(event);
  deltaByTurn.set(key, event);
}

export class EventStore {
  #events = [];
  #seq = 0;
  #writes = Promise.resolve();
  #emitter = new EventEmitter();
  #appendFile;
  #deltaByTurn = new Map();

  constructor({ filePath, maxMemory = 5000, appendFileImpl = appendFile }) {
    this.filePath = filePath;
    this.maxMemory = maxMemory;
    this.#appendFile = appendFileImpl;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let content;
    try {
      content = await this.#readLog();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return;
    }
    this.#events = [];
    this.#deltaByTurn = new Map();
    let lastSeq = 0;
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event.seq)) lastSeq = Math.max(lastSeq, event.seq);
      retain(this.#events, this.#deltaByTurn, event);
      while (this.#events.length > this.maxMemory) this.#evictOldest();
    }
    this.#seq = lastSeq;
  }

  async #readLog() {
    const handle = await open(this.filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size <= MAX_INIT_BYTES) return await readFile(this.filePath, "utf8");
      const start = size - MAX_INIT_BYTES;
      const buffer = Buffer.alloc(MAX_INIT_BYTES);
      await handle.read(buffer, 0, MAX_INIT_BYTES, start);
      const text = buffer.toString("utf8");
      // The first line of a mid-file slice is almost certainly partial.
      const firstBreak = text.indexOf("\n");
      return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    } finally {
      await handle.close();
    }
  }

  get lastSeq() {
    return this.#seq;
  }

  #evictOldest() {
    const dropped = this.#events.shift();
    if (dropped?.kind === "message.delta") {
      const key = deltaKey(dropped);
      if (this.#deltaByTurn.get(key) === dropped) this.#deltaByTurn.delete(key);
    }
  }

  async append(kind, payload, context = {}) {
    const event = {
      v: 1,
      eventId: randomUUID(),
      seq: ++this.#seq,
      time: new Date().toISOString(),
      machineId: context.machineId ?? "local",
      sessionId: context.sessionId ?? null,
      turnId: context.turnId ?? null,
      kind,
      actor: context.actor ?? { type: "bridge" },
      payload,
    };

    // Persist the chunk exactly as it arrived. Merging happens on the in-memory
    // copy only; writing the merged text would store a growing prefix per line
    // and make the log grow quadratically.
    const persisted = { ...event };
    retain(this.#events, this.#deltaByTurn, event);
    while (this.#events.length > this.maxMemory) this.#evictOldest();
    // A transient disk error must not permanently reject the serialized queue.
    // Recover the chain before scheduling the next append, while preserving order.
    const write = this.#writes
      .catch(() => undefined)
      .then(() => this.#appendFile(this.filePath, `${JSON.stringify(persisted)}\n`, "utf8"));
    this.#writes = write;
    try {
      await write;
    } catch (cause) {
      this.#events = this.#events.filter((item) => item.eventId !== event.eventId);
      const error = new Error("AgentBridge event log is temporarily unavailable; please retry");
      error.statusCode = 503;
      error.cause = cause;
      throw error;
    }
    this.#emitter.emit("event", event);
    return event;
  }

  listAfter(seq = 0, { sessionId } = {}) {
    return this.#events.filter((event) => event.seq > seq && (!sessionId || event.sessionId === sessionId));
  }

  subscribe(listener) {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
