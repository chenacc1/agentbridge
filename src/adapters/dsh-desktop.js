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
  capabilities = { streaming: true, stop: true, resume: true, sameConversation: true };

  constructor({ channels }) {
    this.channels = channels;
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
    const handle = { providerSessionId };
    this.channels.attachBridge(providerSessionId, {
      onEvent: (record, state) => dshEventToBridge(record, state, context.emit),
    });
    return handle;
  }

  async send(handle, { text, commandId }) {
    this.channels.enqueue(handle.providerSessionId, { kind: "message", text, commandId });
  }

  async stop(handle) {
    this.channels.enqueue(handle.providerSessionId, { kind: "cancel" });
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
}
