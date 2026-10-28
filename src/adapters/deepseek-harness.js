import { randomUUID } from "node:crypto";
import { lines, probeCommand, spawnCommand } from "./process-utils.js";

const REQUEST_TIMEOUT_MS = 30_000;

function rpcError(error, method) {
  const result = new Error(error?.message ?? ("DeepSeek Harness request failed: " + method));
  result.rpcCode = error?.code;
  return result;
}

function safePayload(value) {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= 12_000 ? value ?? {} : { truncated: true, preview: serialized.slice(0, 12_000) };
}

function toolSummary(update) {
  return {
    id: update?.toolCallId ?? null,
    type: update?.kind ?? "tool",
    status: update?.status ?? null,
    command: update?.rawInput?.command ?? null,
    title: update?.title ?? null,
  };
}

function clipped(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/**
 * Project an ACP `elicitation/create` form schema onto the phone shape.
 *
 * ACP form schemas are flat objects of primitive or enum properties, so each
 * property becomes one question: enums become options, everything else becomes
 * a text field. `message` is the agent's own overall prompt and rides along on
 * every question, because the phone card has no separate place for it.
 */
export function elicitationQuestions(params) {
  const schema = params?.requestedSchema;
  const properties = schema && typeof schema.properties === "object" && schema.properties ? schema.properties : {};
  const message = clipped(params?.message, 2_000);
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  return Object.entries(properties).slice(0, 10).flatMap(([key, property]) => {
    if (!property || typeof property !== "object") return [];
    const enumValues = Array.isArray(property.enum)
      ? property.enum.slice(0, 12).map((value) => String(value))
      : Array.isArray(property.items?.enum)
        ? property.items.enum.slice(0, 12).map((value) => String(value))
        : [];
    const names = Array.isArray(property.enumNames) ? property.enumNames.map((value) => String(value)) : [];
    const options = enumValues.map((value, index) => ({ label: value, ...(names[index] ? { description: clipped(names[index], 200) } : {}) }));
    if (property.type === "boolean") {
      options.length = 0;
      options.push({ label: "是" }, { label: "否" });
    }
    const title = clipped(property.title, 200) || key;
    const description = clipped(property.description, 500);
    return [{
      id: key,
      header: title,
      question: [message, description].filter(Boolean).join(" · ") || title,
      ...(options.length ? { options } : {}),
      ...(property.type === "array" ? { multiSelect: true } : {}),
    }];
  });
}

/**
 * Convert the phone's answer batch into an ACP `accept` content object.
 *
 * Values are typed from the schema rather than trusted as strings: an ACP agent
 * validates `content` again, and a "true" that stays a string fails its check.
 */
export function elicitationContent(params, answers) {
  const properties = params?.requestedSchema?.properties ?? {};
  const required = new Set(Array.isArray(params?.requestedSchema?.required) ? params.requestedSchema.required.map(String) : []);
  const byId = new Map((Array.isArray(answers) ? answers : []).map((answer) => [answer.id, answer]));
  const content = {};
  for (const [key, property] of Object.entries(properties)) {
    const answer = byId.get(key) ?? { selected: [] };
    const selected = Array.isArray(answer.selected) ? answer.selected : [];
    const custom = String(answer.custom ?? "").trim();
    const raw = selected[0] ?? custom;
    if (!selected.length && !custom) {
      if (required.has(key)) throw Object.assign(new Error(`The agent requires an answer for "${clipped(property?.title, 200) || key}"`), { statusCode: 400, code: "INPUT_ANSWER_INVALID" });
      continue;
    }
    if (property?.type === "boolean") {
      content[key] = raw === "是" || raw === "true";
    } else if (property?.type === "array") {
      content[key] = selected.length ? selected : [custom];
    } else if (property?.type === "number" || property?.type === "integer") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw Object.assign(new Error(`"${clipped(property?.title, 200) || key}" must be a number`), { statusCode: 400, code: "INPUT_ANSWER_INVALID" });
      content[key] = property.type === "integer" ? Math.trunc(parsed) : parsed;
    } else {
      content[key] = raw;
    }
  }
  return content;
}

export function acpUpdateToEvent(update) {
  if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    return { kind: "message.delta", payload: { role: "assistant", text: update.content.text ?? "" } };
  }
  if (update?.sessionUpdate === "tool_call") return { kind: "tool.started", payload: toolSummary(update) };
  if (update?.sessionUpdate === "tool_call_update") {
    const done = ["completed", "failed", "cancelled"].includes(update.status);
    return { kind: done ? "tool.completed" : "tool.started", payload: toolSummary(update) };
  }
  return null;
}

export class DeepSeekHarnessAdapter {
  id = "deepseek-harness";
  label = "DeepSeek Harness";
  capabilities = {
    create: true,
    attach: true,
    discover: false,
    streaming: true,
    approve: true,
    answer: true,
    resume: true,
    cancel: true,
    selectModel: false,
    realAgent: true,
  };
  #spawnProcess;
  #probe;
  #handles = new Map();

  constructor({ spawnProcess = spawnCommand, probe = probeCommand } = {}) {
    this.#spawnProcess = spawnProcess;
    this.#probe = probe;
  }

  async detect() {
    const result = await this.#probe("dsh");
    if (!result.available) {
      return {
        ...result,
        supported: false,
        note: "未检测到官方 dsh。请先按 DeepSeek Harness 官方文档安装并配置模型，然后重启 AgentBridge。",
        docsUrl: "https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart",
      };
    }
    return {
      ...result,
      supported: true,
      note: "通过官方 dsh --profile acp 创建独立会话；输出为 Harness 已提交的回答块，模型与凭据由本机 Harness 配置决定。",
      docsUrl: "https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart",
    };
  }

  async start(context) {
    const handle = await this.#connect(context);
    const result = await this.#request(handle, "session/new", {
      cwd: context.cwd,
      additionalDirectories: [],
      mcpServers: [],
    });
    handle.providerSessionId = result?.sessionId;
    if (!handle.providerSessionId) throw new Error("DeepSeek Harness did not return a session id");
    this.#handles.set(handle.providerSessionId, handle);
    return handle;
  }

  async attach(context, providerSessionId) {
    const handle = await this.#connect(context);
    const result = await this.#request(handle, "session/resume", {
      sessionId: providerSessionId,
      cwd: context.cwd,
      additionalDirectories: [],
      mcpServers: [],
    });
    handle.providerSessionId = result?.sessionId ?? providerSessionId;
    this.#handles.set(handle.providerSessionId, handle);
    return handle;
  }

  async send(handle, { text, attachments = [], emit }) {
    if (handle.closed) throw Object.assign(new Error("DeepSeek Harness ACP process is not running"), { statusCode: 409 });
    if (handle.activeTurnId) throw Object.assign(new Error("DeepSeek Harness is already running a turn"), { statusCode: 409 });
    const turnId = randomUUID();
    handle.emit = emit;
    handle.activeTurnId = turnId;
    handle.messageText = "";
    handle.messageStarted = false;
    await emit("turn.started", { adapter: this.id }, { turnId });
    try {
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const attachment of attachments) {
        // ACP carries images as their own content block; other files travel as a
        // path the agent can read, because the protocol has no file block.
        if (attachment.isImage && attachment.dataBase64) {
          blocks.push({ type: "image", data: attachment.dataBase64, mimeType: attachment.mimeType });
        } else {
          blocks.push({ type: "text", text: `附件 ${attachment.name} 的路径：${attachment.path}` });
        }
      }
      if (!blocks.length) blocks.push({ type: "text", text: "" });
      const result = await this.#request(handle, "session/prompt", {
        sessionId: handle.providerSessionId,
        prompt: blocks,
      });
      const stopReason = result?.stopReason ?? "end_turn";
      if (handle.messageStarted || handle.messageText) {
        await emit("message.completed", { role: "assistant", text: handle.messageText }, { turnId });
      }
      await emit(stopReason === "cancelled" ? "turn.cancelled" : "turn.completed", { status: stopReason }, { turnId });
    } finally {
      handle.activeTurnId = null;
    }
  }

  async stop(handle) {
    if (!handle?.activeTurnId || handle.closed) return false;
    this.#notify(handle, "session/cancel", { sessionId: handle.providerSessionId });
    return true;
  }

  async resolveApproval(handle, approvalId, decision) {
    const approval = handle.approvals.get(approvalId);
    if (!approval) throw Object.assign(new Error("Approval is missing or already resolved"), { statusCode: 409 });
    handle.approvals.delete(approvalId);
    const allow = approval.options.find((option) => option?.kind === "allow_once") ?? approval.options.find((option) => /^allow/.test(option?.kind ?? ""));
    const result = decision === "approve" && allow?.optionId
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } };
    this.#send(handle, { jsonrpc: "2.0", id: approval.rpcId, result });
    return true;
  }

  // ACP's answer to "ask the human" is `elicitation/create`; the reply is an
  // action plus schema-typed content, not a free-form message.
  async resolveInput(handle, requestId, { answers = [], cancel = false } = {}) {
    const pending = handle.inputs.get(requestId);
    if (!pending) throw Object.assign(new Error("This question is missing or already answered"), { statusCode: 409 });
    if (cancel) {
      handle.inputs.delete(requestId);
      this.#send(handle, { jsonrpc: "2.0", id: pending.rpcId, result: { action: "decline" } });
      return true;
    }
    // Content is validated before the request is retired: an unusable answer
    // must leave the question answerable instead of consuming it.
    const content = elicitationContent(pending.params, answers);
    handle.inputs.delete(requestId);
    this.#send(handle, { jsonrpc: "2.0", id: pending.rpcId, result: { action: "accept", content } });
    return true;
  }

  async dispose(handle) {
    if (!handle || handle.closed) return;
    handle.closed = true;
    handle.emit = null;
    handle.child.kill();
  }

  async #connect(context) {
    const child = this.#spawnProcess("dsh", ["--profile", "acp"], {
      cwd: context.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle = {
      context,
      child,
      providerSessionId: null,
      activeTurnId: null,
      nextRequestId: 1,
      pending: new Map(),
      approvals: new Map(),
      inputs: new Map(),
      stderr: "",
      messageText: "",
      messageStarted: false,
      emit: null,
      closed: false,
    };
    lines(child.stdout, (line) => this.#onLine(handle, line));
    child.stderr.on("data", (chunk) => { handle.stderr = (handle.stderr + chunk).slice(-8_000); });
    child.on("exit", (code, signal) => {
      handle.closed = true;
      for (const pending of handle.pending.values()) pending.reject(new Error("DeepSeek Harness ACP exited (" + (code ?? signal) + ")"));
      handle.pending.clear();
      if (handle.emit) void handle.emit("adapter.exited", { adapter: this.id, code, signal, stderr: handle.stderr.slice(-2_000) });
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.#request(handle, "initialize", {
      protocolVersion: 1,
      // ACP requires each elicitation mode to be advertised explicitly, and an
      // agent must not request a mode the client never offered. Form mode is
      // what the phone can render; URL mode needs a browser hand-off we do not
      // provide, so it stays unadvertised.
      clientCapabilities: { elicitation: { form: {} } },
    });
    return handle;
  }

  #send(handle, message) {
    if (handle.closed || !handle.child.stdin.writable) throw new Error("DeepSeek Harness ACP stdin is closed");
    handle.child.stdin.write(JSON.stringify(message) + "\n");
  }

  #notify(handle, method, params) {
    this.#send(handle, { jsonrpc: "2.0", method, params });
  }

  #request(handle, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = handle.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        reject(new Error("DeepSeek Harness request timed out: " + method));
      }, timeoutMs);
      handle.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#send(handle, { jsonrpc: "2.0", id, method, params });
    });
  }

  #onLine(handle, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (handle.emit) void handle.emit("adapter.output", { stream: "stdout", text: line }, { turnId: handle.activeTurnId });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = handle.pending.get(message.id);
      if (!pending) return;
      handle.pending.delete(message.id);
      if (message.error) pending.reject(rpcError(message.error, "ACP"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#onServerRequest(handle, message);
      return;
    }
    if (message.method === "session/update" && handle.emit) this.#onSessionUpdate(handle, message.params ?? {});
  }

  #onServerRequest(handle, message) {
    if (!handle.emit) {
      this.#send(handle, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      return;
    }
    if (message.method === "elicitation/create") {
      const params = message.params ?? {};
      if (params.mode !== "form") {
        // Only form mode is advertised, so a URL-mode request is declined rather
        // than left pending: there is no browser to hand off to from the phone.
        this.#send(handle, { jsonrpc: "2.0", id: message.id, result: { action: "decline" } });
        return;
      }
      const questions = elicitationQuestions(params);
      if (!questions.length) {
        this.#send(handle, { jsonrpc: "2.0", id: message.id, result: { action: "decline" } });
        return;
      }
      const requestId = randomUUID();
      handle.inputs.set(requestId, { rpcId: message.id, params });
      void handle.emit("input.requested", {
        requestId,
        adapter: this.id,
        questions,
        expiresAt: Date.now() + 30 * 60_000,
      }, { turnId: handle.activeTurnId });
      return;
    }
    if (message.method !== "session/request_permission") {
      this.#send(handle, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      return;
    }
    const approvalId = randomUUID();
    const params = message.params ?? {};
    handle.approvals.set(approvalId, { rpcId: message.id, options: Array.isArray(params.options) ? params.options : [] });
    void handle.emit("approval.requested", {
      approvalId,
      adapter: this.id,
      method: message.method,
      request: safePayload({ toolCall: params.toolCall, options: params.options }),
      expiresAt: Date.now() + 5 * 60_000,
    }, { turnId: handle.activeTurnId });
  }

  #onSessionUpdate(handle, params) {
    if (params.sessionId !== handle.providerSessionId) return;
    const mapped = acpUpdateToEvent(params.update);
    if (!mapped) return;
    if (mapped.kind === "message.delta") {
      const text = mapped.payload.text;
      if (!text) return;
      if (!handle.messageStarted) {
        handle.messageStarted = true;
        void handle.emit("message.started", { role: "assistant" }, { turnId: handle.activeTurnId });
      }
      handle.messageText += text;
    }
    void handle.emit(mapped.kind, mapped.payload, { turnId: handle.activeTurnId });
  }
}
