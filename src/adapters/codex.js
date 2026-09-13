import { randomUUID } from "node:crypto";
import { lines, spawnCommand as spawnProcess, probeCommand as probeProcess } from "./process-utils.js";

function safePayload(value) {
  const serialized = JSON.stringify(value ?? {});
  if (serialized.length <= 12000) return value ?? {};
  return { truncated: true, preview: serialized.slice(0, 12000) };
}

function itemText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => part?.text ?? "").join("");
  }
  return "";
}

function itemSummary(item) {
  return {
    id: item?.id ?? null,
    type: item?.type ?? "unknown",
    status: item?.status ?? null,
    command: item?.command ?? null,
    cwd: item?.cwd ?? null,
    tool: item?.tool ?? null,
    server: item?.server ?? null,
    changes: item?.changes ?? null,
  };
}

function modelDirectory(result) {
  const models = Array.isArray(result?.data) ? result.data.flatMap((entry) => {
    const id = String(entry?.model ?? entry?.id ?? "").slice(0, 160);
    if (!id) return [];
    const efforts = Array.isArray(entry?.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((effort) => {
        const effortId = String(effort?.reasoningEffort ?? "").slice(0, 100);
        return effortId ? [{ id: effortId, name: String(effort.description ?? effortId).slice(0, 160) }] : [];
      })
      : [];
    return [{
      id,
      name: String(entry.displayName ?? id).slice(0, 160),
      ...(efforts.length ? { reasoning: { efforts } } : {}),
    }];
  }) : [];
  return {
    source: "codex-app-server",
    routable: true,
    current: null,
    groups: models.length ? [{ id: "openai", name: "OpenAI Codex", models }] : [],
    failures: models.length ? [] : [{ id: "codex-model-list", name: "Codex", message: "Codex did not return any picker-visible models for this account." }],
  };
}

export class CodexAdapter {
  id = "codex";
  label = "OpenAI Codex";
  capabilities = {
    streaming: true,
    approvals: true,
    resume: true,
    cancel: true,
    realAgent: true,
  };
  #handles = new Map();

  constructor({ spawn = spawnProcess, probe = probeProcess } = {}) {
    this.spawn = spawn;
    this.probe = probe;
  }

  async detect() {
    return this.probe("codex");
  }

  async start(context) {
    const handle = await this.#connect(context);
    const result = await this.#request(handle, "thread/start", {
      cwd: context.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      personality: "pragmatic",
    });
    handle.providerSessionId = result?.thread?.id;
    if (!handle.providerSessionId) throw new Error("Codex did not return a thread id");
    await this.#loadModelDirectory(handle);
    this.#handles.set(handle.providerSessionId, handle);
    return handle;
  }

  async attach(context, providerSessionId) {
    const handle = await this.#connect(context);
    const result = await this.#request(handle, "thread/resume", {
      threadId: providerSessionId,
      cwd: context.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    handle.providerSessionId = result?.thread?.id ?? providerSessionId;
    await this.#loadModelDirectory(handle);
    this.#handles.set(handle.providerSessionId, handle);
    return handle;
  }

  async #connect(context) {
    const child = this.spawn("codex", ["app-server", "--stdio"], {
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
      closed: false,
      modelDirectory: null,
      selectedModel: null,
    };

    lines(child.stdout, (line) => this.#onLine(handle, line));
    child.stderr.on("data", (chunk) => {
      handle.stderr = `${handle.stderr}${chunk}`.slice(-8000);
    });
    child.on("exit", (code, signal) => {
      handle.closed = true;
      for (const pending of handle.pending.values()) {
        pending.reject(new Error(`Codex app-server exited (${code ?? signal})`));
      }
      handle.pending.clear();
      if (handle.emit) {
        void handle.emit("adapter.exited", { adapter: this.id, code, signal, stderr: handle.stderr.slice(-2000) });
      }
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.#request(handle, "initialize", {
      clientInfo: { name: "agentbridge", title: "AgentBridge", version: "0.1.0" },
    });
    this.#notify(handle, "initialized", {});
    return handle;
  }

  async send(handle, { text, emit, commandId }) {
    if (handle.closed) throw Object.assign(new Error("Codex app-server is not running"), { statusCode: 409 });
    handle.emit = emit;
    const result = await this.#request(handle, "turn/start", {
      threadId: handle.providerSessionId,
      input: [{ type: "text", text }],
      clientUserMessageId: commandId,
      ...(handle.selectedModel ? {
        model: handle.selectedModel.model,
        ...(handle.selectedModel.reasoningEffort ? { effort: handle.selectedModel.reasoningEffort } : {}),
      } : {}),
    });
    handle.activeTurnId = result?.turn?.id ?? handle.activeTurnId;
  }

  async stop(handle) {
    if (!handle.activeTurnId || handle.closed) return false;
    await this.#request(handle, "turn/interrupt", {
      threadId: handle.providerSessionId,
      turnId: handle.activeTurnId,
    });
    return true;
  }

  async resolveApproval(handle, approvalId, decision) {
    const approval = handle.approvals.get(approvalId);
    if (!approval) throw Object.assign(new Error("Approval is missing or already resolved"), { statusCode: 409 });
    handle.approvals.delete(approvalId);
    const method = approval.method.toLowerCase();
    let result;
    if (method.includes("execcommandapproval") || method.includes("applypatchapproval")) {
      result = { decision: decision === "approve" ? "approved" : "denied" };
    } else if (method.includes("permissions")) {
      result = decision === "approve"
        ? { permissions: approval.params?.permissions ?? {}, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    } else {
      result = { decision: decision === "approve" ? "accept" : "decline" };
    }
    this.#send(handle, { id: approval.rpcId, result });
    return true;
  }

  async dispose(handle) {
    if (handle.closed) return;
    handle.child.kill();
    handle.closed = true;
  }

  modelDirectory(handle) {
    return handle.modelDirectory ?? null;
  }

  async selectModel(handle, selection) {
    const directory = this.modelDirectory(handle);
    const group = directory?.groups.find((item) => item.id === selection.provider);
    const target = group?.models.find((item) => item.id === selection.model);
    if (!target) {
      throw Object.assign(new Error("The selected model is not available from this Codex model directory"), { statusCode: 403 });
    }
    if (selection.reasoningEffort && !target.reasoning?.efforts.some((item) => item.id === selection.reasoningEffort)) {
      throw Object.assign(new Error("The selected reasoning effort is not supported by this Codex model"), { statusCode: 400 });
    }
    handle.selectedModel = {
      provider: group.id,
      model: target.id,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
    handle.modelDirectory = { ...directory, current: handle.selectedModel };
    return { selected: handle.selectedModel };
  }

  async #loadModelDirectory(handle) {
    try {
      handle.modelDirectory = modelDirectory(await this.#request(handle, "model/list", { limit: 100, includeHidden: false }));
    } catch (error) {
      handle.modelDirectory = {
        source: "codex-app-server",
        routable: true,
        current: null,
        groups: [],
        failures: [{ id: "codex-model-list", name: "Codex", message: String(error.message ?? "Could not list models").slice(0, 500) }],
      };
    }
  }

  #send(handle, message) {
    if (handle.closed || !handle.child.stdin.writable) throw new Error("Codex stdin is closed");
    handle.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(handle, method, params) {
    this.#send(handle, { method, params });
  }

  #request(handle, method, params, timeoutMs = 15000) {
    const id = handle.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      handle.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#send(handle, { id, method, params });
    });
  }

  #onLine(handle, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (handle.emit) void handle.emit("adapter.output", { stream: "stdout", text: line });
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = handle.pending.get(message.id);
      if (!pending) return;
      handle.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#onServerRequest(handle, message);
      return;
    }

    if (message.method && handle.emit) this.#onNotification(handle, message.method, message.params ?? {});
  }

  #onServerRequest(handle, message) {
    const method = String(message.method);
    if (!/approval|requestapproval|permissions/i.test(method) || !handle.emit) {
      this.#send(handle, { id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      return;
    }
    const approvalId = randomUUID();
    handle.approvals.set(approvalId, { rpcId: message.id, method, params: message.params ?? {} });
    void handle.emit("approval.requested", {
      approvalId,
      adapter: this.id,
      method,
      request: safePayload(message.params),
      expiresAt: Date.now() + 5 * 60_000,
    });
  }

  #onNotification(handle, method, params) {
    const turnId = params.turnId ?? params.turn?.id ?? handle.activeTurnId;
    if (method === "turn/started") {
      handle.activeTurnId = params.turn?.id ?? params.turnId ?? handle.activeTurnId;
      void handle.emit("turn.started", { adapter: this.id, provider: safePayload(params.turn) }, { turnId });
      return;
    }
    if (method === "turn/completed") {
      void handle.emit("turn.completed", { status: params.turn?.status ?? "completed" }, { turnId });
      handle.activeTurnId = null;
      return;
    }
    if (method === "item/agentMessage/delta") {
      void handle.emit("message.delta", { role: "assistant", text: params.delta ?? "" }, { turnId });
      return;
    }
    if (method === "item/started") {
      const item = params.item;
      if (item?.type === "agentMessage") {
        void handle.emit("message.started", { role: "assistant", itemId: item.id }, { turnId });
      } else if (item?.type !== "userMessage") {
        void handle.emit("tool.started", itemSummary(item), { turnId });
      }
      return;
    }
    if (method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage") {
        void handle.emit("message.completed", { role: "assistant", text: itemText(item), itemId: item.id }, { turnId });
      } else if (item?.type !== "userMessage") {
        void handle.emit("tool.completed", itemSummary(item), { turnId });
      }
      return;
    }
    if (/outputdelta|reasoning/i.test(method)) {
      void handle.emit("adapter.output", { method, data: safePayload(params) }, { turnId });
    }
  }
}
