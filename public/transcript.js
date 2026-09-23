import { renderMessageMarkdown } from "./markdown.js";

// Pure transcript logic, kept out of app.js so it can be tested directly with
// Node and the real Markdown renderer instead of only in a browser. Everything
// here is about one promise: the phone shows the whole conversation, no matter
// how many tokens the agent streamed.

// Real conversation keeps its place: token deltas are collapsed to one entry
// per turn, so completed messages and status changes are never squeezed out.
export const MAX_EVENT_HISTORY = 4000;
export const HISTORY_TRIM_CHUNK = 750;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function deltaKeyOf(event) {
  return `${event.sessionId ?? ""}\u0000${event.turnId ?? ""}`;
}

export function indexDeltas(events, index = new Map()) {
  index.clear();
  for (const event of events) {
    if (event.kind === "message.delta") index.set(deltaKeyOf(event), event);
  }
  return index;
}

// Token deltas are folded into a single cumulative entry per turn, matching the
// bridge. Without this a long turn's tokens fill the whole buffer and push the
// actual conversation out of it, which is why replies used to arrive missing or
// half-rendered.
export function absorbEvent(events, deltaIndex, event) {
  if (event.kind !== "message.delta") {
    events.push(event);
    return event;
  }
  const text = String(event.payload?.text ?? "");
  const existing = deltaIndex.get(deltaKeyOf(event));
  if (existing) {
    const current = String(existing.payload?.text ?? "");
    const offset = Number.isInteger(event.payload?.offset) ? event.payload.offset : current.length;
    // `offset` is the character position this chunk starts at, so a merged or
    // replayed chunk rewrites the same text instead of duplicating it.
    const merged = offset >= current.length ? current + text : current.slice(0, offset) + text;
    existing.payload = { ...existing.payload, text: merged, offset: 0 };
    existing.time = event.time;
    return existing;
  }
  const entry = { ...event, payload: { ...event.payload, offset: 0 } };
  deltaIndex.set(deltaKeyOf(event), entry);
  events.push(entry);
  return entry;
}

export function trimEvents(events, deltaIndex, { maxEvents = MAX_EVENT_HISTORY, trimChunk = HISTORY_TRIM_CHUNK } = {}) {
  if (events.length <= maxEvents) return false;
  events.splice(0, events.length - maxEvents + trimChunk);
  indexDeltas(events, deltaIndex);
  return true;
}

export function foldDeltas(relevant) {
  const completedTurns = new Set();
  const textByTurn = new Map();
  for (const event of relevant) {
    if (event.kind === "message.completed" && event.payload.role === "assistant") completedTurns.add(event.turnId);
  }
  for (const event of relevant) {
    if (event.kind !== "message.delta") continue;
    const text = String(event.payload?.text ?? "");
    const current = textByTurn.get(event.turnId) ?? "";
    const offset = Number.isInteger(event.payload?.offset) ? event.payload.offset : current.length;
    textByTurn.set(event.turnId, offset >= current.length ? current + text : current.slice(0, offset) + text);
  }
  return { textByTurn, completedTurns };
}

export function entryKey(event) {
  return event.kind === "message.delta" ? `delta:${event.sessionId}:${event.turnId}` : `${event.kind}:${event.eventId}`;
}

const DEFAULT_STATUS_LABELS = {
  "session.created": "会话已创建",
  "session.ready": "Agent 已就绪",
  "turn.started": "本轮已开始",
  "turn.completed": "本轮已完成",
  "turn.cancelled": "本轮已取消",
  "control.granted": "输入控制权已更新",
  "turn.stop_requested": "已请求停止本轮",
  "model.changed": "模型已切换",
};

const STATUS_KINDS = [
  "session.created", "session.ready", "turn.started", "turn.completed",
  "turn.cancelled", "control.granted", "turn.stop_requested", "model.changed",
];

const entryCache = new WeakMap();

function formatTime(value, formatter) {
  return formatter ? formatter(value) : new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function entryFor(event, label, text, className, supportsMarkdown, { formatMessageTime, cache }) {
  const stable = event.kind !== "message.delta";
  const cached = stable ? cache.get(event) : null;
  if (cached) return cached;
  const content = supportsMarkdown
    ? renderMessageMarkdown(text)
    : `<p>${escapeHtml(String(text ?? ""))}</p>`;
  const entry = {
    key: entryKey(event),
    className,
    html: `<time class="event-time">${formatTime(event.time, formatMessageTime)}</time><div class="event-body"><strong>${escapeHtml(label)}</strong><div class="message-markdown">${content}</div></div>`,
  };
  if (stable) cache.set(event, entry);
  return entry;
}

function approvalEntry(event, options) {
  const cached = options.cache.get(event);
  if (cached) return cached;
  const request = JSON.stringify(event.payload.request ?? {}, null, 2).slice(0, 1600);
  const entry = {
    key: entryKey(event),
    className: "",
    html: `<time class="event-time">${formatTime(event.time, options.formatMessageTime)}</time><div class="event-body approval-entry"><strong>需要你的批准</strong><p>${escapeHtml(event.payload.method)}\n${escapeHtml(request)}</p><div class="approval-actions"><button class="approve" data-approval="${event.payload.approvalId}" data-decision="approve" type="button">仅本次批准</button><button class="deny" data-approval="${event.payload.approvalId}" data-decision="deny" type="button">拒绝</button></div></div>`,
  };
  options.cache.set(event, entry);
  return entry;
}

/** Turn a session's events into the list of transcript entries to display. */
export function buildEntries(relevant, options = {}) {
  const statusLabel = options.statusLabel ?? ((kind) => DEFAULT_STATUS_LABELS[kind] ?? kind);
  const settings = { cache: entryCache, formatMessageTime: options.formatMessageTime };
  const { textByTurn, completedTurns } = foldDeltas(relevant);

  const renderedDeltas = new Set();
  const entries = [];
  for (const event of relevant) {
    if (event.kind === "message.delta") {
      if (completedTurns.has(event.turnId) || renderedDeltas.has(event.turnId)) continue;
      renderedDeltas.add(event.turnId);
      entries.push(entryFor(event, "Agent 正在回复", textByTurn.get(event.turnId) ?? "", "assistant", true, settings));
    } else if (event.kind === "message.completed") {
      entries.push(entryFor(event, event.payload.role === "user" ? "你" : "Agent", event.payload.text, event.payload.role, true, settings));
    } else if (event.kind === "tool.started" || event.kind === "tool.completed") {
      const label = event.kind.endsWith("started") ? "工具开始" : "工具完成";
      const detail = event.payload.command ? String(event.payload.command) : `${event.payload.type ?? "tool"}${event.payload.status ? ` · ${event.payload.status}` : ""}`;
      entries.push(entryFor(event, label, detail, "tool", false, settings));
    } else if (event.kind === "approval.requested") {
      entries.push(approvalEntry(event, settings));
    } else if (event.kind === "turn.failed" || event.kind === "session.failed" || event.kind === "adapter.exited") {
      entries.push(entryFor(event, "执行异常", event.payload.error ?? event.payload.stderr ?? event.kind, "error", false, settings));
    } else if (STATUS_KINDS.includes(event.kind)) {
      entries.push(entryFor(event, "状态", statusLabel(event.kind), "tool", false, settings));
    }
  }
  return entries;
}
