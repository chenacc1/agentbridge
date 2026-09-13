import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class EventStore {
  #events = [];
  #seq = 0;
  #writes = Promise.resolve();
  #emitter = new EventEmitter();
  #appendFile;

  constructor({ filePath, maxMemory = 5000, appendFileImpl = appendFile }) {
    this.filePath = filePath;
    this.maxMemory = maxMemory;
    this.#appendFile = appendFileImpl;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      this.#events = parsed.slice(-this.maxMemory);
      this.#seq = parsed.at(-1)?.seq ?? 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get lastSeq() {
    return this.#seq;
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

    this.#events.push(event);
    if (this.#events.length > this.maxMemory) this.#events.shift();
    // A transient disk error must not permanently reject the serialized queue.
    // Recover the chain before scheduling the next append, while preserving order.
    const write = this.#writes
      .catch(() => undefined)
      .then(() => this.#appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8"));
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
