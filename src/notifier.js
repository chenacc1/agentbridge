/**
 * Outbound notifications for the moments a phone user cannot afford to miss.
 *
 * The whole product promise is "let the agent run while you are away", but nothing
 * can be away-proof if the only signal is a page that has to be open. This module
 * pushes the three moments that actually block progress — a pending approval, a
 * pending question, and a finished or failed turn — to a channel the user already
 * watches (a WeCom bot, Telegram, ServerChan, or any endpoint that accepts JSON).
 *
 * Design rules, learned the hard way elsewhere in this codebase:
 * - Never throw: a dead webhook must not fail the turn it is describing.
 * - Never block: the caller fires and forgets; `send` resolves to a result object.
 * - Never storm: transcripts emit many events, so identical (session, kind) pairs
 *   are rate limited, and only the five meaningful kinds are forwarded at all.
 * - Never leak the access key unless the operator explicitly opts in.
 */

const FORMATS = new Set(["json", "wecom", "telegram", "serverchan", "pushplus"]);

const DEFAULT_TITLES = {
  "approval.requested": "需要批准",
  "input.requested": "等你回答",
  "turn.completed": "回合结束",
  "turn.failed": "回合失败",
  "session.failed": "会话失败",
  "notify.test": "通知测试",
};

function clip(value, limit) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Build the human-readable body of a notification, in the app's own voice. */
export function describeNotification(kind, payload = {}, context = {}) {
  const sessionLabel = clip(context.sessionTitle || "未命名会话", 60);
  const adapter = clip(context.adapterLabel ?? context.adapterId ?? "", 40);
  const where = [sessionLabel, adapter].filter(Boolean).join(" · ");
  switch (kind) {
    case "approval.requested": {
      const method = clip(payload.request?.toolName ?? payload.method ?? "工具", 60);
      return {
        title: `⚠️ 需要批准：${method}`,
        text: [`${where}`, `Agent 想执行 ${method}，等你确认。`, clip(payload.request?.reason ?? "", 200)].filter(Boolean).join("\n"),
      };
    }
    case "input.requested": {
      const first = payload.questions?.[0];
      const question = clip(first?.question ?? first?.header ?? "一个问题", 200);
      const more = (payload.questions?.length ?? 1) > 1 ? `（共 ${payload.questions.length} 个问题）` : "";
      return { title: `❓ 等你回答${more}`, text: [`${where}`, question].filter(Boolean).join("\n") };
    }
    case "turn.completed": {
      const last = clip(context.lastAssistantText ?? "", 160);
      return { title: `✅ 回合结束：${sessionLabel}`, text: [where, last].filter(Boolean).join("\n") };
    }
    case "turn.failed": {
      return { title: `❌ 回合失败：${sessionLabel}`, text: [where, clip(payload.error ?? "未知错误", 300)].filter(Boolean).join("\n") };
    }
    case "session.failed": {
      return { title: `❌ 会话失败：${sessionLabel}`, text: [where, clip(payload.error ?? "未知错误", 300)].filter(Boolean).join("\n") };
    }
    case "notify.test": {
      return { title: "🔔 AgentBridge 通知测试", text: [`${where}`, "如果你看到这条消息，通知链路是通的。"].filter(Boolean).join("\n") };
    }
    default:
      return { title: DEFAULT_TITLES[kind] ?? "AgentBridge", text: where };
  }
}

/** Shape the request for one provider. Kept separate so it can be unit tested. */
export function buildWebhookRequest({ format, webhookUrl, chatId, token, channel, title, text, payload }) {
  if (format === "wecom") {
    return { url: webhookUrl, body: { msgtype: "text", text: { content: `${title}\n${text}` } } };
  }
  if (format === "serverchan") {
    return { url: webhookUrl, body: { title, desp: text.replace(/\n/g, "\n\n") } };
  }
  if (format === "pushplus") {
    // PushPlus takes `token` in the body (or in the URL as /send/{token}), plus a
    // title and content; `txt` keeps the newlines a chat message needs.
    const tokenInUrl = /[?&]token=|\/send\/[^/?]+/.test(webhookUrl);
    return {
      url: webhookUrl,
      body: {
        ...(!tokenInUrl && token ? { token } : {}),
        title,
        content: `${title}\n${text}`,
        template: "txt",
        // PushPlus delivers through a chosen channel; `clawbot` is the 微信ClawBot one.
        ...(channel ? { channel } : {}),
      },
    };
  }
  if (format === "telegram") {
    return {
      url: webhookUrl,
      body: {
        ...(chatId ? { chat_id: chatId } : {}),
        text: `${title}\n${text}`,
        disable_web_page_preview: true,
      },
    };
  }
  // Generic JSON: a superset that custom receivers, Discord and Slack-style
  // endpoints can all read (`text` is the common denominator).
  return { url: webhookUrl, body: { ...payload, title, text: `${title}\n${text}` } };
}

/**
 * Providers answer HTTP 200 and put the real result in the body.
 *
 * This is the difference between "the test button said sent" and a message that
 * actually arrived: WeCom returns `errcode`, PushPlus returns `code`, ServerChan
 * returns `code`/`data.errno`, Telegram returns `ok`. The generic `json` format is
 * left alone because a custom endpoint's body is its own business.
 */
export function providerProblem(format, body) {
  if (!body || typeof body !== "object") return null;
  const describe = (code, message) => `provider-${code}${message ? `:${String(message).slice(0, 120)}` : ""}`;
  if (format === "wecom" && Number(body.errcode) > 0) return describe(body.errcode, body.errmsg);
  if (format === "pushplus") {
    const code = Number(body.code);
    if (Number.isFinite(code) && code !== 200) return describe(code, body.msg ?? body.message);
    return null;
  }
  if (format === "serverchan") {
    if (Number(body.code) > 0) return describe(body.code, body.message);
    if (body.data && Number(body.data.errno) > 0) return describe(body.data.errno, body.data.errmsg);
    return null;
  }
  if (format === "telegram" && body.ok === false) return describe(body.error_code ?? "error", body.description);
  return null;
}

export class Notifier {
  #fmt = "json";
  #webhookUrl = null;
  #chatId = null;
  #token = null;
  #channel = null;
  #muted = false;
  #linkUrl = null;
  #fetch = null;
  #now = () => Date.now();
  #logger = console;
  #timeoutMs = 5_000;
  #minIntervalMs = 15_000;
  #lastSent = new Map();

  constructor(options = {}) {
    const format = String(options.format ?? "json").toLowerCase();
    this.#fmt = FORMATS.has(format) ? format : "json";
    this.#webhookUrl = typeof options.webhookUrl === "string" && options.webhookUrl.trim() ? options.webhookUrl.trim() : null;
    this.#chatId = options.chatId ? String(options.chatId) : null;
    this.#token = options.token ? String(options.token) : null;
    this.#channel = options.channel ? String(options.channel) : null;
    this.#muted = options.muted === true;
    this.#linkUrl = typeof options.linkUrl === "string" && options.linkUrl.trim() ? options.linkUrl.trim() : null;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof options.now === "function") this.#now = options.now;
    if (options.logger) this.#logger = options.logger;
    if (Number.isFinite(options.timeoutMs)) this.#timeoutMs = options.timeoutMs;
    if (Number.isFinite(options.minIntervalMs)) this.#minIntervalMs = options.minIntervalMs;
  }

  get enabled() {
    return Boolean(this.#webhookUrl);
  }

  get format() {
    return this.#fmt;
  }

  /** The provider-specific delivery channel, when one is configured. */
  get channel() {
    return this.#channel;
  }

  /**
   * Muted means configured-but-silent: the phone can stop the buzzing without
   * throwing away the webhook, the token or the channel.
   */
  get muted() {
    return this.#muted;
  }

  setMuted(value) {
    this.#muted = value === true;
    return this.#muted;
  }

  /**
   * Send one notification. Always resolves: `{ sent, reason }` describes what
   * happened, and a failure is logged instead of thrown.
   */
  async send(kind, payload, context = {}) {
    if (!this.enabled) return { sent: false, reason: "disabled" };
    if (this.#muted) return { sent: false, reason: "muted" };
    if (kind !== "notify.test") {
      const key = `${context.sessionId ?? "-"}:${kind}`;
      const last = this.#lastSent.get(key);
      // The first signal for a pair always goes out; only repeats are damped.
      if (last !== undefined && this.#now() - last < this.#minIntervalMs) {
        return { sent: false, reason: "rate-limited" };
      }
      this.#lastSent.set(key, this.#now());
      if (this.#lastSent.size > 500) this.#lastSent.delete(this.#lastSent.keys().next().value);
    }

    const { title, text } = describeNotification(kind, payload, context);
    const body = {
      kind,
      machine: clip(context.machineName ?? "", 60),
      sessionId: context.sessionId ?? null,
      sessionTitle: clip(context.sessionTitle ?? "", 100),
      adapter: context.adapterId ?? null,
      at: new Date(this.#now()).toISOString(),
      ...(this.#linkUrl ? { url: this.#linkUrl } : {}),
    };
    const request = buildWebhookRequest({
      format: this.#fmt,
      webhookUrl: this.#webhookUrl,
      chatId: this.#chatId,
      token: this.#token,
      channel: this.#channel,
      title,
      text,
      payload: body,
    });

    try {
      const response = await this.#fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response?.ok) {
        this.#logger.warn?.(`AgentBridge notification rejected (${response?.status ?? "no response"})`);
        return { sent: false, reason: `http-${response?.status ?? "error"}` };
      }
      // A 200 with an error code in the body is the normal failure mode of these
      // providers, and reporting it as "sent" would make the test button lie.
      let providerBody = null;
      try {
        if (typeof response.text === "function") {
          const raw = await response.text();
          if (raw) providerBody = JSON.parse(raw);
        }
      } catch {
        providerBody = null;
      }
      const problem = providerProblem(this.#fmt, providerBody);
      if (problem) {
        this.#logger.warn?.(`AgentBridge notification rejected by the provider (${problem})`);
        return { sent: false, reason: problem };
      }
      return { sent: true };
    } catch (error) {
      // A notification is best-effort by definition: never let it break a turn.
      this.#logger.warn?.(`AgentBridge notification failed: ${error instanceof Error ? error.message : String(error)}`);
      return { sent: false, reason: "error" };
    }
  }
}
