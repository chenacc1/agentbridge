import { randomUUID } from "node:crypto";

export class EchoAdapter {
  id = "echo";
  label = "Echo Demo";
  capabilities = {
    streaming: true,
    approvals: true,
    resume: false,
    cancel: true,
    realAgent: false,
  };
  #runs = new Map();

  async detect() {
    return { available: true, version: "built-in" };
  }

  async start(context) {
    return { providerSessionId: randomUUID(), context };
  }

  async send(handle, { text, emit }) {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.#runs.set(handle.providerSessionId, controller);
    await emit("turn.started", { adapter: this.id }, { turnId });
    await emit("message.started", { role: "assistant" }, { turnId });

    const response = `已收到：${text}\n\n这是 Echo 适配器，用于验证微信扫码、实时同步和断线补拉。`;
    for (const chunk of response.match(/.{1,5}/gs) ?? []) {
      if (controller.signal.aborted) {
        await emit("turn.cancelled", { reason: "user" }, { turnId });
        this.#runs.delete(handle.providerSessionId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 45));
      await emit("message.delta", { role: "assistant", text: chunk }, { turnId });
    }

    await emit("message.completed", { role: "assistant", text: response }, { turnId });
    await emit("turn.completed", { status: "completed" }, { turnId });
    this.#runs.delete(handle.providerSessionId);
  }

  async stop(handle) {
    return this.#runs.get(handle.providerSessionId)?.abort() ?? false;
  }

  async resolveApproval() {
    throw Object.assign(new Error("Echo has no pending approval"), { statusCode: 409 });
  }
}

