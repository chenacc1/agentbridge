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
  // Set once the in-memory window has dropped anything. Until then the window
  // still holds every event, so a per-session history read never needs the log.
  #evicted = false;

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

  async #readLog(maxBytes = MAX_INIT_BYTES) {
    const handle = await open(this.filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) return await readFile(this.filePath, "utf8");
      const start = size - maxBytes;
      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, start);
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
    if (!dropped) return;
    this.#evicted = true;
    if (dropped.kind === "message.delta") {
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

  /**
   * History for one session, independent of what else shares the window.
   *
   * The replay window is global, so a busy session can evict a quiet one and a
   * phone that switches to it would render an empty transcript. Once anything
   * has been evicted the log tail is read back for that one session, which makes
   * switching always land on real history instead of on a hole.
   *
   * `beforeSeq` pages backwards: the page holds the newest events strictly older
   * than that cursor, so "加载更早" walks one window at a time instead of asking
   * for everything at once.
   */
  async readSessionHistory(sessionId, { limit = 300, beforeSeq = null } = {}) {
    const wanted = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 300;
    const cursor = Number.isSafeInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : null;
    const withinCursor = (event) => cursor === null || event.seq < cursor;
    const inMemory = this.listAfter(0, { sessionId }).filter(withinCursor);
    let events = inMemory;
    let fromLog = false;
    if (this.#evicted) {
      const persisted = await this.#readSessionFromLog(sessionId);
      if (persisted.length) {
        fromLog = true;
        const bySeq = new Map();
        for (const event of persisted) {
          if (withinCursor(event)) bySeq.set(event.seq, event);
        }
        for (const event of inMemory) bySeq.set(event.seq, event);
        events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      }
    }
    const hasMore = events.length > wanted;
    const page = hasMore ? events.slice(-wanted) : events;
    return {
      events: page,
      truncated: hasMore,
      hasMore,
      oldestSeq: page.length ? page[0].seq : null,
      lastSeq: page.length ? page.at(-1).seq : 0,
      fromLog,
    };
  }

  async #readSessionFromLog(sessionId) {
    let content;
    try {
      content = await this.#readLog();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const events = [];
    const deltaByTurn = new Map();
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.sessionId !== sessionId || !Number.isSafeInteger(event.seq)) continue;
      // Same coalescing as the live window: history is read for display, and a
      // raw delta flood would push the conversation out of it again.
      retain(events, deltaByTurn, event);
    }
    return events;
  }

  /**
   * Case-insensitive search across conversation text.
   *
   * Long-running agents produce conversations you cannot re-read from the top, so
   * "which conversation did I agree to that in" has to be answerable. Only message
   * text is searched (what a person remembers), the newest hits win, and every
   * result carries the session and sequence so the phone can jump straight there.
   */
  async search(query, { limit = 30, perSession = 5, maxLogBytes = 24 * 1024 * 1024 } = {}) {
    const needle = String(query ?? "").trim().toLowerCase();
    const wanted = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const hits = [];
    if (needle.length < 2) return { hits, scanned: 0, truncated: false };

    const consider = (event, source) => {
      if (!event || !Number.isSafeInteger(event.seq)) return;
      const payload = event.payload ?? {};
      let text = "";
      let role = "agent";
      if (event.kind === "message.completed") {
        text = String(payload.text ?? "");
        role = payload.role === "user" ? "user" : "assistant";
      } else if (event.kind === "tool.started" || event.kind === "tool.completed") {
        text = [payload.command, payload.type].filter(Boolean).join(" ");
        role = "tool";
      } else {
        return;
      }
      if (!text) return;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) return;
      const padded = text.slice(Math.max(0, at - 40), Math.min(text.length, at + needle.length + 60)).replace(/\s+/g, " ").trim();
      hits.push({
        sessionId: event.sessionId ?? null,
        seq: event.seq,
        at: event.time ?? event.at ?? null,
        kind: event.kind,
        role,
        snippet: padded,
        source,
      });
    };

    // Newest first, so a cap keeps the most relevant recent matches.
    const memory = this.listAfter(0);
    let scanned = 0;
    for (let index = memory.length - 1; index >= 0 && hits.length < wanted * 3; index -= 1) {
      scanned += 1;
      consider(memory[index], "memory");
    }

    let truncated = false;
    if (this.#evicted) {
      let content = null;
      try {
        content = await this.#readLog(maxLogBytes);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (content === null) truncated = true;
      if (content) {
        const lines = content.split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0 && hits.length < wanted * 3; index -= 1) {
          const line = lines[index];
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          scanned += 1;
          consider(event, "log");
        }
      }
    }

    // De-duplicate the same event seen in both places, then keep the newest.
    const seen = new Set();
    const unique = [];
    for (const hit of hits) {
      const key = `${hit.sessionId}:${hit.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(hit);
    }
    unique.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));

    const perSessionCount = new Map();
    const balanced = [];
    for (const hit of unique) {
      const count = perSessionCount.get(hit.sessionId) ?? 0;
      if (count >= perSession) continue;
      perSessionCount.set(hit.sessionId, count + 1);
      balanced.push(hit);
      if (balanced.length >= wanted) break;
    }
    return { hits: balanced, scanned, truncated };
  }

  subscribe(listener) {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
