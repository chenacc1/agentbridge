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

// Trimming normally drops the oldest entries, which is exactly what a freshly
// fetched history page is. `keepSessionId` drops other conversations' oldest
// entries first, so switching to a quiet conversation cannot be undone a moment
// later by a busy one that is still streaming.
export function trimEvents(events, deltaIndex, { maxEvents = MAX_EVENT_HISTORY, trimChunk = HISTORY_TRIM_CHUNK, keepSessionId = null } = {}) {
  if (events.length <= maxEvents) return false;
  const target = events.length - maxEvents + trimChunk;
  let removed = 0;
  if (keepSessionId) {
    for (let index = 0; index < events.length && removed < target; index += 1) {
      if (events[index].sessionId === keepSessionId) continue;
      events.splice(index, 1);
      index -= 1;
      removed += 1;
    }
  }
  if (removed < target) events.splice(0, target - removed);
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

// Live events and per-session history describe the same seq space, and a switch
// can overlap a stream that is still arriving. De-duplicating by eventId and
// re-sorting by seq keeps both sources honest: no entry is rendered twice, and
// a fetched page slots in ahead of whatever already arrived live.
export function mergeHistory(events, deltaIndex, incoming, knownIds = null) {
  if (!Array.isArray(incoming) || !incoming.length) return 0;
  // `knownIds` is the caller's live set of every id in the buffer; without it the
  // set is derived from `events`, which is enough for a one-shot merge but not for
  // a buffer that keeps growing from the live stream.
  const known = knownIds instanceof Set ? knownIds : new Set(events.map((event) => event.eventId).filter(Boolean));
  let added = 0;
  for (const event of incoming) {
    if (!event || !Number.isSafeInteger(event.seq)) continue;
    if (event.eventId && known.has(event.eventId)) continue;
    if (event.eventId) known.add(event.eventId);
    events.push(event);
    added += 1;
  }
  if (!added) return 0;
  events.sort((a, b) => a.seq - b.seq);
  indexDeltas(events, deltaIndex);
  return added;
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

// A question answered on the desktop, or skipped on the phone, still has to
// leave a readable trace: the card above it can never be answered again.
const RESOLVED_LABELS = {
  answered: "已回答",
  cancelled: "已跳过",
  desktop: "已在电脑上回答",
  expired: "超时未答，已自动拒绝",
};

const APPROVAL_RESOLVED_LABELS = {
  approve: "已批准（仅本次）",
  deny: "已拒绝",
};

const entryCache = new WeakMap();

// Math rendering arrives one tick after the first paint (KaTeX is fetched only
// when the transcript needs it). Bumping the generation invalidates the memoised
// HTML so the formulas re-render instead of staying as raw TeX.
let renderGeneration = 0;

export function bumpRenderGeneration() {
  renderGeneration += 1;
}

// `key` lets one event render two ways (a question card before and after it is
// answered): the memoised HTML is only reused when the key still matches.
function cachedEntry(cache, event, key) {
  const cached = cache.get(event);
  if (!cached || cached.generation !== renderGeneration) return null;
  if (key !== undefined && cached.key !== key) return null;
  return cached.entry;
}

function rememberEntry(cache, event, entry, key) {
  cache.set(event, { generation: renderGeneration, entry, key });
  return entry;
}

function formatTime(value, formatter) {
  return formatter ? formatter(value) : new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Attachments the phone sent with a message.
 *
 * Images render as a thumbnail that opens full size; anything else renders as a
 * named chip. Both point at the bridge's own preview URL, so the picture is the
 * real file the agent received, not a local copy.
 */
function attachmentsHtml(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const items = list.map((attachment) => {
    const id = escapeHtml(String(attachment?.id ?? ""));
    const name = escapeHtml(String(attachment?.name ?? "附件"));
    const size = Number(attachment?.bytes) > 0 ? `${Math.max(1, Math.round(Number(attachment.bytes) / 1024))} KB` : "";
    const url = `/api/attachments/${encodeURIComponent(String(attachment?.id ?? ""))}`;
    if (attachment?.isImage) {
      return `<a class="attachment-thumb" href="${url}" target="_blank" rel="noreferrer" data-attachment="${id}">
        <img src="${url}" alt="${name}" loading="lazy" decoding="async">
        <span class="attachment-caption">${name}${size ? ` · ${size}` : ""}</span>
      </a>`;
    }
    return `<a class="attachment-file" href="${url}" target="_blank" rel="noreferrer" data-attachment="${id}">📎 ${name}${size ? ` · ${size}` : ""}</a>`;
  }).join("");
  return `<div class="message-attachments">${items}</div>`;
}
function entryFor(event, label, text, className, supportsMarkdown, { formatMessageTime, cache, math }) {
  const stable = event.kind !== "message.delta";
  const cached = stable ? cachedEntry(cache, event) : null;
  if (cached) return cached;
  const content = supportsMarkdown
    ? renderMessageMarkdown(text, math ? { math } : undefined)
    : `<p>${escapeHtml(String(text ?? ""))}</p>`;
  const attachments = attachmentsHtml(event.payload?.attachments);
  const entry = {
    key: entryKey(event),
    className,
    html: `<time class="event-time">${formatTime(event.time, formatMessageTime)}</time><div class="event-body"><strong>${escapeHtml(label)}</strong><div class="message-markdown">${content}</div>${attachments}</div>`,
  };
  if (stable) rememberEntry(cache, event, entry);
  return entry;
}

/**
 * Tool calls get the two affordances a person actually needs: the command is
 * copyable, and a long output collapses instead of pushing the conversation off the
 * screen. Both work without JavaScript state — `<details>` is the disclosure.
 */
function toolEntry(event, label, text, options) {
  const cached = cachedEntry(options.cache, event);
  if (cached) return cached;
  const body = String(text ?? "");
  const long = body.length > 240;
  const command = typeof event.payload?.command === "string" ? event.payload.command : "";
  const copy = command
    ? `<button class="tool-copy" type="button" data-copy-tool="${escapeHtml(body)}">复制命令</button>`
    : "";
  const shown = long
    ? `<details class="tool-output"><summary>展开完整输出（${body.length} 字符）</summary><pre>${escapeHtml(body)}</pre></details>`
    : `<div class="message-markdown"><p>${escapeHtml(body)}</p></div>`;
  const entry = {
    key: entryKey(event),
    className: "tool",
    html: `<time class="event-time">${formatTime(event.time, options.formatMessageTime)}</time><div class="event-body"><strong>${escapeHtml(label)}</strong>${copy}${shown}</div>`,
  };
  return rememberEntry(options.cache, event, entry);
}
function approvalEntry(event, options) {
  const cached = cachedEntry(options.cache, event);
  if (cached) return cached;
  const request = JSON.stringify(event.payload.request ?? {}, null, 2).slice(0, 1600);
  const entry = {
    key: entryKey(event),
    className: "",
    html: `<time class="event-time">${formatTime(event.time, options.formatMessageTime)}</time><div class="event-body approval-entry"><strong>需要你的批准</strong><p>${escapeHtml(event.payload.method)}\n${escapeHtml(request)}</p><div class="approval-actions"><button class="approve" data-approval="${event.payload.approvalId}" data-decision="approve" type="button">仅本次批准</button><button class="deny" data-approval="${event.payload.approvalId}" data-decision="deny" type="button">拒绝</button></div></div>`,
  };
  return rememberEntry(options.cache, event, entry);
}

// An agent that stops to ask a question is blocked until a human answers, so a
// card of dead text would strand the turn. Options render as real inputs and the
// submit button posts one batch, in the order the questions were asked.
//
// Once the question is resolved the card must stop looking answerable: it used to keep
// its buttons forever, so a reload offered a card whose submit could only 409. The card
// is folded into a settled form (options as static text, no buttons, outcome named).
function inputEntry(event, options, settledOutcome) {
  const cacheKey = settledOutcome ? `${settledOutcome}:${entryKey(event)}` : entryKey(event);
  const cached = cachedEntry(options.cache, event, cacheKey);
  if (cached) return cached;
  const settled = Boolean(settledOutcome);
  const requestId = escapeHtml(event.payload.requestId);
  const questions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
  const blocks = questions.map((question, index) => {
    const questionId = escapeHtml(question.id);
    const multi = question.multiSelect === true;
    const options = Array.isArray(question.options) ? question.options : [];
    const choices = options.map((option) => {
      const label = String(option.label ?? "");
      const description = option.description
        ? `<small class="input-option-note">${escapeHtml(option.description)}</small>`
        : "";
      if (settled) {
        return `<span class="input-option settled"><span>${escapeHtml(label)}${description}</span></span>`;
      }
      return `<label class="input-option"><input type="${multi ? "checkbox" : "radio"}" name="q-${requestId}-${index}" value="${escapeHtml(label)}" data-input-option> <span>${escapeHtml(label)}${description}</span></label>`;
    }).join("");
    return `<div class="input-question" data-input-question="${questionId}"${multi ? ' data-input-multi="1"' : ""}>`
      + (question.header ? `<p class="input-header">${escapeHtml(question.header)}</p>` : "")
      + `<p class="input-prompt">${escapeHtml(question.question)}</p>`
      + (choices ? `<div class="input-options">${choices}</div>` : "")
      + (settled
        ? ""
        : `<input class="input-custom" type="${question.secret === true ? "password" : "text"}" data-input-custom placeholder="${options.length ? "或者直接输入回答" : "输入你的回答"}">`)
      + "</div>";
  }).join("");
  const footnote = settled ? `<p class="input-settled">${escapeHtml(RESOLVED_LABELS[settledOutcome] ?? "已处理")}</p>` : "";
  const entry = {
    // The key changes with the settled state: the transcript diff only rewrites an
    // entry when its key changes, so a card that resolves in place would otherwise
    // keep offering its buttons until the whole list re-rendered.
    key: settled ? `settled:${entryKey(event)}` : entryKey(event),
    className: settled ? "settled" : "",
    html: `<time class="event-time">${formatTime(event.time, options.formatMessageTime)}</time><div class="event-body input-entry${settled ? " is-settled" : ""}"><strong>${settled ? "Agent 的提问" : "Agent 在等你回答"}</strong>${blocks}${footnote}`
      + (settled ? "" : `<div class="approval-actions"><button class="approve" data-input-submit="${requestId}" type="button">提交回答</button><button class="deny" data-input-cancel="${requestId}" type="button">跳过</button></div>`)
      + "</div>",
  };
  return rememberEntry(options.cache, event, entry, cacheKey);
}

/** Turn a session's events into the list of transcript entries to display. */
export function buildEntries(relevant, options = {}) {
  const statusLabel = options.statusLabel ?? ((kind) => DEFAULT_STATUS_LABELS[kind] ?? kind);
  const settings = { cache: entryCache, formatMessageTime: options.formatMessageTime, math: options.math };
  const { textByTurn, completedTurns } = foldDeltas(relevant);
  // A question's outcome arrives as a later event, so it has to be known before the
  // card that asked it is rendered — otherwise the card keeps offering buttons that
  // can only fail once the desktop has already answered.
  const settledInputs = new Map();
  for (const event of relevant) {
    if (event.kind === "input.resolved" && event.payload?.requestId) {
      settledInputs.set(event.payload.requestId, event.payload.outcome ?? "answered");
    }
  }

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
      entries.push(toolEntry(event, label, detail, settings));
    } else if (event.kind === "approval.requested") {
      entries.push(approvalEntry(event, settings));
    } else if (event.kind === "input.requested") {
      entries.push(inputEntry(event, settings, settledInputs.get(event.payload?.requestId)));
    } else if (event.kind === "input.resolved") {
      entries.push(entryFor(event, "提问", RESOLVED_LABELS[event.payload?.outcome] ?? "已处理", "tool", false, settings));
    } else if (event.kind === "approval.resolved") {
      entries.push(entryFor(
        event,
        "审批",
        event.payload?.auto
          ? `已自动放行（限时策略）`
          : APPROVAL_RESOLVED_LABELS[event.payload?.decision] ?? "已处理",
        "tool",
        false,
        settings,
      ));
    } else if (event.kind === "turn.failed" || event.kind === "session.failed" || event.kind === "adapter.exited") {
      entries.push(entryFor(event, "执行异常", event.payload.error ?? event.payload.stderr ?? event.kind, "error", false, settings));
    } else if (STATUS_KINDS.includes(event.kind)) {
      entries.push(entryFor(event, "状态", statusLabel(event.kind), "tool", false, settings));
    }
  }
  return entries;
}
