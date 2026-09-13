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
    streaming: true,
    approvals: true,
    resume: true,
    cancel: true,
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

  async send(handle, { text, emit }) {
    if (handle.closed) throw Object.assign(new Error("DeepSeek Harness ACP process is not running"), { statusCode: 409 });
    if (handle.activeTurnId) throw Object.assign(new Error("DeepSeek Harness is already running a turn"), { statusCode: 409 });
    const turnId = randomUUID();
    handle.emit = emit;
    handle.activeTurnId = turnId;
    handle.messageText = "";
    handle.messageStarted = false;
    await emit("turn.started", { adapter: this.id }, { turnId });
    try {
      const result = await this.#request(handle, "session/prompt", {
        sessionId: handle.providerSessionId,
        prompt: [{ type: "text", text }],
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

  async dispose(handle) {
    if (!handle || handle.closed) return;
    handle.closed = true;
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
      clientCapabilities: {},
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
    if (message.method !== "session/request_permission" || !handle.emit) {
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
