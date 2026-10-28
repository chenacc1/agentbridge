import { randomUUID } from "node:crypto";

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 25;

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || block?.type === "reasoning")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function turnId(providerSessionId, turn) {
  return `${providerSessionId}:${turn}`;
}

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/**
 * Project DSH's `AskUserQuestionRequest` questions onto the phone's wire shape.
 *
 * The phone renders these directly, so every field is length-capped and rebuilt
 * as a plain object: the request arrives from another process and must never be
 * forwarded as an opaque live value.
 */
export function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_QUESTIONS).flatMap((question, index) => {
    if (!question || typeof question !== "object") return [];
    const questionText = text(question.question, 4_000);
    if (!questionText) return [];
    const options = Array.isArray(question.options)
      ? question.options.slice(0, MAX_OPTIONS).flatMap((option) => {
        const label = text(option?.label, 200);
        if (!label) return [];
        const description = text(option?.description, 500);
        return [{ label, ...(description ? { description } : {}) }];
      })
      : [];
    const header = text(question.header, 200);
    return [{
      id: text(question.id, 100) || `q${index + 1}`,
      question: questionText,
      ...(header ? { header } : {}),
      ...(options.length ? { options } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });
}

export async function dshEventToBridge(record, state, emit) {
  const { event, origin } = record;
  const data = event.data ?? {};
  const extra = Number.isSafeInteger(data.turn) ? { turnId: turnId(state.providerSessionId, data.turn) } : {};

  switch (event.type) {
    case "turn/start":
      return emit("turn.started", {
        adapter: "deepseek-harness-desktop",
        provider: state.provider,
        model: state.model,
        dshEventSeq: event.seq,
      }, extra);
    case "assistant/chunk":
      if (data.chunk?.type === "text-delta" && data.chunk.text) {
        return emit("message.delta", { role: "assistant", text: data.chunk.text, dshEventSeq: event.seq }, extra);
      }
      if (data.chunk?.type === "reasoning-delta" && data.chunk.text) {
        return emit("adapter.output", { stream: "reasoning", text: data.chunk.text, dshEventSeq: event.seq }, extra);
      }
      return undefined;
    case "assistant/message":
      return emit("message.completed", {
        role: "assistant",
        text: contentText(data.message?.content),
        provider: data.message?.source?.provider ?? state.provider,
        model: data.message?.source?.model ?? state.model,
        usage: data.usage,
        dshEventSeq: event.seq,
      }, extra);
    case "user/message":
      if (origin === "phone") return undefined;
      return emit("message.completed", {
        role: "user",
        text: contentText(data.content),
        source: "dsh-desktop",
        dshEventSeq: event.seq,
      }, extra);
    case "tool/call":
      return emit("tool.started", {
        type: data.name,
        command: data.arguments,
        callId: data.callId,
        dshEventSeq: event.seq,
      }, extra);
    case "tool/result":
      return emit("tool.completed", {
        type: data.message?.content?.[0]?.toolCallId ? "tool-result" : "tool",
        callId: data.message?.content?.[0]?.toolCallId,
        text: contentText(data.message?.content?.[0]?.content),
        status: data.message?.content?.[0]?.isError || data.error ? "error" : "completed",
        error: data.error,
        dshEventSeq: event.seq,
      }, extra);
    case "turn/end": {
      const kind = data.reason?.kind;
      const bridgeKind = kind === "cancelled" || kind === "interrupted" ? "turn.cancelled" : "turn.completed";
      return emit(bridgeKind, { reason: data.reason, dshEventSeq: event.seq }, extra);
    }
    default:
      return undefined;
  }
}

export class DshDesktopAdapter {
  id = "deepseek-harness-desktop";
  label = "DeepSeek Harness Desktop";

  constructor({ channels }) {
    this.channels = channels;
  }

  /**
   * A new conversation can only be opened inside the desktop app, so `create`
   * is true exactly while a companion is paired: the bridge asks that companion
   * to open one, and the companion registers it back. `createReason` explains
   * the refusal in the phone's create sheet instead of a dead greyed row.
   */
  get capabilities() {
    const online = this.channels.hasOnlineChannel();
    return {
      create: online,
      ...(online ? {} : { createReason: "桌面端离线" }),
      attach: true,
      discover: false,
      resume: true,
      cancel: true,
      approve: true,
      answer: true,
      selectModel: true,
      streaming: true,
      sameConversation: true,
    };
  }

  async detect() {
    return {
      available: true,
      supported: true,
      mode: "desktop-companion",
      note: "Run /phone inside a DSH Desktop conversation to attach it",
    };
  }

  async attach(context, providerSessionId) {
    return this.#handleFor(providerSessionId, context);
  }

  /**
   * Create a conversation *in the desktop app* and hand it to the bridge.
   *
   * The phone cannot start a DSH process of its own here: the conversation has to
   * exist inside the running desktop so both surfaces share it. So this asks the
   * paired companion to open one and waits for it to register, then wires the
   * usual bridge observability onto the new provider session.
   */
  async start(context) {
    const created = await this.channels.requestSession({
      cwd: context.cwd,
      title: context.title,
      bridgeSessionId: context.bridgeSessionId,
    });
    return this.#handleFor(created.providerSessionId, context);
  }

  #handleFor(providerSessionId, context) {
    const handle = {
      providerSessionId,
      emit: context.emit,
      // Pending human interactions, keyed by the id AgentBridge hands the phone
      // and carrying the DSH rpc id that answers them. Kept on the runtime
      // handle rather than persisted: a question dies with its turn.
      inputs: new Map(),
      approvals: new Map(),
    };
    this.channels.attachBridge(providerSessionId, {
      onEvent: (record, state) => dshEventToBridge(record, state, context.emit),
      onInteraction: (interaction) => this.#onInteraction(handle, interaction),
    });
    return handle;
  }

  async send(handle, { text: prompt, attachments = [], commandId }) {
    // The companion forwards a single text frame, so attachments are handed over as
    // absolute paths the DSH agent can read with its tools.
    const lines = attachments.map((attachment) => `[附件] ${attachment.name} → ${attachment.path}`);
    const composed = [prompt, ...lines].filter(Boolean).join("\n\n");
    this.channels.enqueue(handle.providerSessionId, { kind: "message", text: composed, commandId });
  }

  async stop(handle) {
    this.channels.enqueue(handle.providerSessionId, { kind: "cancel" });
    return true;
  }

  // DSH Desktop asks the human in two different shapes: a question form
  // (`ask_user_question`) and a one-off approval prompt. Both block the turn
  // exactly like an approval does, so both must reach the phone; `selectModel`
  // is the existing precedent for waiting on a real desktop confirmation.
  async resolveInput(handle, requestId, { answers = [], cancel = false } = {}) {
    const pending = handle.inputs.get(requestId);
    if (!pending) throw Object.assign(new Error("This question is missing or already answered"), { statusCode: 409 });
    handle.inputs.delete(requestId);
    await this.channels.request(handle.providerSessionId, cancel
      ? { kind: "cancel-question", rpcId: pending.rpcId }
      : { kind: "answer-question", rpcId: pending.rpcId, answers });
    return true;
  }

  async resolveApproval(handle, approvalId, decision) {
    const pending = handle.approvals.get(approvalId);
    if (!pending) throw Object.assign(new Error("Approval is missing or already resolved"), { statusCode: 409 });
    handle.approvals.delete(approvalId);
    await this.channels.request(handle.providerSessionId, {
      kind: "answer-approval",
      rpcId: pending.rpcId,
      dshApprovalId: pending.dshApprovalId,
      outcome: decision === "approve" ? "allowed-once" : "rejected",
    });
    return true;
  }

  modelDirectory(handle) {
    return this.channels.metadata(handle.providerSessionId)?.modelDirectory ?? null;
  }

  async selectModel(handle, selection) {
    const directory = this.modelDirectory(handle);
    const provider = directory?.groups.find((group) => group.id === selection.provider);
    const target = provider?.models.find((model) => model.id === selection.model);
    if (!target) throw Object.assign(new Error("The selected model is not in the current DSH Desktop model directory"), { statusCode: 403 });
    if (selection.reasoningEffort && !target.reasoning?.efforts.some((effort) => effort.id === selection.reasoningEffort)) {
      throw Object.assign(new Error("The selected reasoning effort is not available for this model"), { statusCode: 400 });
    }
    return this.channels.request(handle.providerSessionId, { kind: "select-model", selection });
  }

  #onInteraction(handle, interaction) {
    const emit = handle.emit;
    if (!emit || !interaction) return;
    if (interaction.kind === "question-requested") {
      const questions = normalizeQuestions(interaction.questions);
      if (!questions.length) return;
      const requestId = randomUUID();
      handle.inputs.set(requestId, { rpcId: interaction.requestId });
      void emit("input.requested", {
        requestId,
        adapter: this.id,
        questions,
        expiresAt: Date.now() + 30 * 60_000,
      });
      return;
    }
    if (interaction.kind === "approval-requested") {
      const approvalId = randomUUID();
      const toolName = text(interaction.toolName, 200) || "tool";
      const reason = text(interaction.reason, 2_000);
      const callId = text(interaction.callId, 200);
      handle.approvals.set(approvalId, { rpcId: interaction.requestId, dshApprovalId: text(interaction.dshApprovalId, 200) });
      void emit("approval.requested", {
        approvalId,
        adapter: this.id,
        method: toolName,
        request: { toolName, ...(reason ? { reason } : {}), ...(callId ? { callId } : {}) },
        expiresAt: Date.now() + 30 * 60_000,
      });
      return;
    }
    // The desktop window answered first: retire the phone's now-stale card
    // instead of leaving a button that can only fail.
    if (interaction.kind === "question-resolved") {
      for (const [requestId, pending] of handle.inputs) {
        if (pending.rpcId !== interaction.requestId) continue;
        handle.inputs.delete(requestId);
        void emit("input.resolved", { requestId, outcome: "desktop" });
        return;
      }
      return;
    }
    if (interaction.kind === "approval-resolved") {
      for (const [approvalId, pending] of handle.approvals) {
        if (pending.dshApprovalId !== interaction.dshApprovalId) continue;
        handle.approvals.delete(approvalId);
        void emit("approval.resolved", {
          approvalId,
          decision: interaction.outcome === "allowed-once" ? "approve" : "deny",
        });
        return;
      }
    }
  }
}
