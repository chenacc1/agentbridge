import { randomUUID } from "node:crypto";
import { lines, spawnCommand, probeCommand } from "./process-utils.js";
import { CcSwitchModelCatalog } from "../cc-switch-models.js";

function textFromAssistant(message) {
  const content = message?.message?.content ?? message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("");
}

export class ClaudeAdapter {
  id = "claude";
  label = "Claude Code";
  capabilities = {
    streaming: true,
    approvals: false,
    resume: true,
    cancel: true,
    realAgent: true,
  };
  #runs = new Map();
  #spawn;
  #model;
  #modelCatalog;
  #firstOutputTimeoutMs;

  constructor({
    spawn = spawnCommand,
    model = process.env.AGENTBRIDGE_CLAUDE_MODEL || null,
    modelCatalog = new CcSwitchModelCatalog(),
    firstOutputTimeoutMs = Number(process.env.AGENTBRIDGE_CLAUDE_FIRST_OUTPUT_TIMEOUT_MS || 30_000),
  } = {}) {
    this.#spawn = spawn;
    this.#model = typeof model === "string" && model.trim() ? model.trim() : null;
    this.#modelCatalog = modelCatalog;
    this.#firstOutputTimeoutMs = Number.isFinite(firstOutputTimeoutMs) && firstOutputTimeoutMs > 0
      ? firstOutputTimeoutMs
      : 30_000;
  }

  async detect() {
    return probeCommand("claude");
  }

  async start(context) {
    return {
      providerSessionId: randomUUID(),
      context,
      started: false,
      modelDirectory: await this.#currentModelDirectory(),
      selectedModel: null,
    };
  }

  async attach(context, providerSessionId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providerSessionId)) {
      throw Object.assign(new Error("Claude session id must be a UUID"), { statusCode: 400 });
    }
    return {
      providerSessionId,
      context,
      started: true,
      attached: true,
      modelDirectory: await this.#currentModelDirectory(),
      selectedModel: null,
    };
  }

  modelDirectory(handle) {
    return handle.modelDirectory ?? null;
  }

  async selectModel(handle, selection) {
    const directory = this.modelDirectory(handle);
    const group = directory?.groups.find((entry) => entry.id === selection.provider);
    const target = group?.models.find((entry) => entry.id === selection.model);
    if (!target) {
      throw Object.assign(new Error("The selected model is not available from the current CC Switch provider"), { statusCode: 403 });
    }
    handle.selectedModel = target.id;
    handle.modelDirectory = { ...directory, current: { provider: group.id, model: target.id } };
    return { selected: handle.modelDirectory.current };
  }

  async send(handle, { text, emit }) {
    if (this.#runs.has(handle.providerSessionId)) {
      throw Object.assign(new Error("Claude is already running a turn"), { statusCode: 409 });
    }

    const turnId = randomUUID();
    const args = [
      "-p",
      text,
    ];
    const selectedModel = handle.selectedModel ?? this.#model;
    if (selectedModel) args.push("--model", selectedModel);
    args.push(
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "manual",
      "--permission-prompts",
      "none",
    );
    if (handle.started) args.push("--resume", handle.providerSessionId);
    else args.push("--session-id", handle.providerSessionId);

    const child = this.#spawn("claude", args, {
      cwd: handle.context.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#runs.set(handle.providerSessionId, child);

    let completedText = "";
    let stderr = "";
    let resultError = "";
    let firstOutputTimer;
    const firstOutputTimeout = new Promise((resolve) => {
      firstOutputTimer = setTimeout(() => resolve({ timedOut: true }), this.#firstOutputTimeoutMs);
    });
    const markFirstOutput = () => {
      if (!firstOutputTimer) return;
      clearTimeout(firstOutputTimer);
      firstOutputTimer = null;
    };
    const close = new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    lines(child.stdout, (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "stream_event") {
          const event = message.event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            markFirstOutput();
            completedText += event.delta.text;
            void emit("message.delta", { role: "assistant", text: event.delta.text }, { turnId });
          }
        } else if (message.type === "assistant") {
          markFirstOutput();
          if (!completedText) {
            const textValue = textFromAssistant(message);
            if (textValue) completedText = textValue;
          }
        } else if (message.type === "result") {
          markFirstOutput();
          if (typeof message.result === "string" && !completedText) completedText = message.result;
          if (message.is_error || String(message.subtype ?? "").startsWith("error")) {
            resultError = Array.isArray(message.errors)
              ? message.errors.join("\n")
              : String(message.result ?? message.subtype ?? "Claude execution failed");
          }
        }
      } catch {
        void emit("adapter.output", { stream: "stdout", text: line }, { turnId });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await emit("turn.started", { adapter: this.id, ...(selectedModel ? { model: selectedModel } : {}) }, { turnId });

    const outcome = await Promise.race([close, firstOutputTimeout]);
    if (firstOutputTimer) clearTimeout(firstOutputTimer);
    this.#runs.delete(handle.providerSessionId);

    if (outcome.timedOut) {
      child.kill();
      await emit("turn.failed", {
        error: `Claude did not produce output within ${this.#firstOutputTimeoutMs}ms. Check the configured model and authentication.`,
        ...(selectedModel ? { model: selectedModel } : {}),
      }, { turnId });
      return;
    }
    if (outcome.error) {
      await emit("turn.failed", { error: outcome.error.message, ...(selectedModel ? { model: selectedModel } : {}) }, { turnId });
      return;
    }
    if (outcome.exitCode === 0 && !resultError) {
      handle.started = true;
      await emit("message.completed", { role: "assistant", text: completedText }, { turnId });
      await emit("turn.completed", { status: "completed" }, { turnId });
      return;
    }
    const error = (resultError || stderr.trim() || `Claude exited with code ${outcome.exitCode ?? "unknown"}`).slice(-2000);
    await emit("turn.failed", {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      error,
      ...(selectedModel ? { model: selectedModel } : {}),
    }, { turnId });
  }

  async stop(handle) {
    const child = this.#runs.get(handle.providerSessionId);
    if (!child) return false;
    child.kill();
    return true;
  }

  async resolveApproval() {
    throw Object.assign(new Error("Claude MVP runs with permission prompts disabled"), { statusCode: 409 });
  }

  async #currentModelDirectory() {
    try {
      return await this.#modelCatalog?.current();
    } catch {
      return null;
    }
  }
}
