import { randomUUID } from "node:crypto";
import { lines, spawnCommand, probeCommand } from "./process-utils.js";
import { CcSwitchModelCatalog } from "../cc-switch-models.js";

function textFromAssistant(message) {
  const content = message?.message?.content ?? message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("");
}

function clipped(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/**
 * Project Claude Code's `AskUserQuestion` input onto the phone shape.
 *
 * Claude keys its answers by the question text (there is no question id), so
 * the text doubles as the stable id in this batch. `preview` is dropped: the
 * phone renders labels and one-line descriptions, and a preview block would
 * arrive as unusable text.
 */
export function claudeQuestions(value) {
  const questions = Array.isArray(value) ? value.slice(0, 4) : [];
  return questions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const prompt = clipped(question.question, 4_000);
    if (!prompt) return [];
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 8).flatMap((option) => {
        const label = clipped(option?.label, 200);
        if (!label) return [];
        const description = clipped(option?.description, 500);
        return [{ label, ...(description ? { description } : {}) }];
      })
      : [];
    return [{
      id: prompt,
      question: prompt,
      ...(question.header ? { header: clipped(question.header, 200) } : {}),
      ...(options.length ? { options } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });
}

export class ClaudeAdapter {
  id = "claude";
  label = "Claude Code";
  capabilities = {
    create: true,
    attach: true,
    discover: false,
    streaming: true,
    approve: true,
    answer: true,
    resume: true,
    cancel: true,
    selectModel: true,
    realAgent: true,
  };
  #runs = new Map();
  #spawn;
  #model;
  #modelCatalog;
  #firstOutputTimeoutMs;
  #interactionTimeoutMs;

  constructor({
    spawn = spawnCommand,
    model = process.env.AGENTBRIDGE_CLAUDE_MODEL || null,
    modelCatalog = new CcSwitchModelCatalog(),
    firstOutputTimeoutMs = Number(process.env.AGENTBRIDGE_CLAUDE_FIRST_OUTPUT_TIMEOUT_MS || 30_000),
    interactionTimeoutMs = Number(process.env.AGENTBRIDGE_CLAUDE_INTERACTION_TIMEOUT_MS || 5 * 60_000),
  } = {}) {
    this.#spawn = spawn;
    this.#model = typeof model === "string" && model.trim() ? model.trim() : null;
    this.#modelCatalog = modelCatalog;
    this.#firstOutputTimeoutMs = Number.isFinite(firstOutputTimeoutMs) && firstOutputTimeoutMs > 0
      ? firstOutputTimeoutMs
      : 30_000;
    // A prompt that reaches no phone must not park the turn forever: Claude
    // keeps the tool call open until the host answers, so an unanswered request
    // is denied here and the run continues with that recorded outcome.
    this.#interactionTimeoutMs = Number.isFinite(interactionTimeoutMs) && interactionTimeoutMs > 0
      ? interactionTimeoutMs
      : 5 * 60_000;
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

  async send(handle, { text, attachments = [], emit }) {
    if (this.#runs.has(handle.providerSessionId)) {
      throw Object.assign(new Error("Claude is already running a turn"), { statusCode: 409 });
    }

    const turnId = randomUUID();
    // Token counts arrive on the result frame, long after the turn starts.
    const runUsage = {};
    const selectedModel = handle.selectedModel ?? this.#model;
    // The prompt travels on stdin as a stream-json user message so the same
    // stdin stays open for the control stream: that is the only channel through
    // which Claude Code asks a human (`can_use_tool`), and `--permission-prompts
    // host` is what makes it consult us instead of deleting the asking tools.
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "manual",
      "--permission-prompts",
      "host",
    ];
    if (selectedModel) args.push("--model", selectedModel);
    if (handle.started) args.push("--resume", handle.providerSessionId);
    else args.push("--session-id", handle.providerSessionId);

    const child = this.#spawn("claude", args, {
      cwd: handle.context.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const run = {
      child,
      turnId,
      emit,
      inputs: new Map(),
      approvals: new Map(),
      guardTimer: null,
      closed: false,
    };
    this.#runs.set(handle.providerSessionId, run);

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
        } else if (message.type === "control_request") {
          // A live CLI waiting on a human is not a stalled CLI: the watchdog
          // must not kill the turn while the question is on the phone.
          markFirstOutput();
          this.#onControlRequest(handle, run, message);
        } else if (message.type === "result") {
          // Claude reports token counts on its result frame; carry them through so the
          // phone can show what a conversation actually costs.
          if (message.usage && typeof message.usage === "object") {
            const input = Number(message.usage.input_tokens ?? message.usage.inputTokens ?? 0);
            const output = Number(message.usage.output_tokens ?? message.usage.outputTokens ?? 0);
            if (input > 0) runUsage.inputTokens = (runUsage.inputTokens ?? 0) + input;
            if (output > 0) runUsage.outputTokens = (runUsage.outputTokens ?? 0) + output;
          }
          markFirstOutput();
          if (typeof message.result === "string" && !completedText) completedText = message.result;
          if (message.is_error || String(message.subtype ?? "").startsWith("error")) {
            resultError = Array.isArray(message.errors)
              ? message.errors.join("\n")
              : String(message.result ?? message.subtype ?? "Claude execution failed");
          }
          // With stream-json input the CLI keeps reading until stdin ends, so
          // the finished turn is what closes it.
          try { child.stdin?.end(); } catch { /* already closed */ }
        }
      } catch {
        void emit("adapter.output", { stream: "stdout", text: line }, { turnId });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", () => { run.closed = true; });

    try {
      // Claude takes images as content blocks and everything else as a path it can
      // open with its own file tools.
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const attachment of attachments) {
        if (attachment.isImage && attachment.dataBase64) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mimeType, data: attachment.dataBase64 },
          });
          if (text === "") blocks.push({ type: "text", text: `（图片：${attachment.name}）` });
        } else {
          blocks.push({ type: "text", text: `附件 ${attachment.name} 的路径：${attachment.path}` });
        }
      }
      if (!blocks.length) blocks.push({ type: "text", text: "" });
      this.#write(run, {
        type: "user",
        message: { role: "user", content: blocks },
      });
    } catch (error) {
      run.closed = true;
      this.#runs.delete(handle.providerSessionId);
      await emit("turn.failed", { error: error.message, ...(selectedModel ? { model: selectedModel } : {}) }, { turnId });
      return;
    }
    await emit("turn.started", { adapter: this.id, ...(selectedModel ? { model: selectedModel } : {}) }, { turnId });

    const outcome = await Promise.race([close, firstOutputTimeout]);
    if (firstOutputTimer) clearTimeout(firstOutputTimer);
    if (run.guardTimer) clearTimeout(run.guardTimer);
    this.#runs.delete(handle.providerSessionId);
    run.closed = true;

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
      await emit("turn.completed", { status: "completed", ...(Object.keys(runUsage).length ? { usage: runUsage } : {}) }, { turnId });
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
    const run = this.#runs.get(handle.providerSessionId);
    if (!run) return false;
    if (run.guardTimer) clearTimeout(run.guardTimer);
    run.closed = true;
    run.child.kill();
    return true;
  }

  // Claude asks the human through the control stream. `AskUserQuestion` is one
  // tool among many, so it is recognised by name; everything else that needs a
  // human is a permission decision.
  #onControlRequest(handle, run, message) {
    const emit = run.emit;
    const controlId = String(message.request_id ?? message.requestId ?? "");
    const request = message.request && typeof message.request === "object" ? message.request : {};
    if (!controlId || !emit) return;
    if (String(request.subtype ?? "") !== "can_use_tool") {
      // Unknown control requests would leave the CLI waiting for an envelope it
      // will never get, so they are refused explicitly.
      this.#controlResponse(run, controlId, { subtype: "error", error: `AgentBridge does not answer control request "${clipped(request.subtype, 60)}"` });
      return;
    }
    const toolName = clipped(request.tool_name ?? request.toolName, 200) || "tool";
    const input = request.input && typeof request.input === "object" ? request.input : {};
    if (toolName === "AskUserQuestion") {
      const questions = claudeQuestions(input.questions);
      if (!questions.length) {
        this.#controlResponse(run, controlId, { subtype: "success", request_id: controlId, response: { behavior: "deny", message: "the question could not be read" } });
        return;
      }
      const requestId = randomUUID();
      run.inputs.set(requestId, { controlId, input });
      this.#armInteractionGuard(run);
      void emit("input.requested", {
        requestId,
        adapter: this.id,
        questions,
        expiresAt: Date.now() + 30 * 60_000,
      });
      return;
    }
    const approvalId = randomUUID();
    run.approvals.set(approvalId, { controlId });
    this.#armInteractionGuard(run);
    const command = typeof input.command === "string" ? clipped(input.command, 2_000) : null;
    void emit("approval.requested", {
      approvalId,
      adapter: this.id,
      method: toolName,
      request: { toolName, ...(command ? { command } : {}) },
      expiresAt: Date.now() + 30 * 60_000,
    });
  }

  // Claude parks the tool call until the host answers. With no phone watching,
  // that would look exactly like the bug this seam exists to fix, so an
  // unanswered request is denied after a bounded wait and the turn continues.
  #armInteractionGuard(run) {
    if (run.guardTimer || run.closed) return;
    run.guardTimer = setTimeout(() => {
      run.guardTimer = null;
      this.#expireInteractions(run);
    }, this.#interactionTimeoutMs);
    run.guardTimer.unref?.();
  }

  #expireInteractions(run) {
    const questions = [...run.inputs.entries()];
    const approvals = [...run.approvals.entries()];
    run.inputs.clear();
    run.approvals.clear();
    if ((!questions.length && !approvals.length) || run.closed) return;
    for (const [, entry] of questions) {
      try {
        this.#denyControl(run, entry.controlId, "no answer arrived from the phone in time");
      } catch {
        return;
      }
    }
    for (const [, entry] of approvals) {
      try {
        this.#denyControl(run, entry.controlId, "no decision arrived from the phone in time");
      } catch {
        return;
      }
    }
    // Retire the phone's cards through the same events a real answer uses, so a
    // timed-out prompt leaves a readable line instead of a dead button.
    for (const [requestId] of questions) void run.emit?.("input.resolved", { requestId, outcome: "expired" });
    for (const [approvalId] of approvals) void run.emit?.("approval.resolved", { approvalId, decision: "deny" });
  }

  #denyControl(run, controlId, message) {
    this.#controlResponse(run, controlId, {
      subtype: "success",
      request_id: controlId,
      response: { behavior: "deny", message },
    });
  }

  async resolveInput(handle, requestId, { answers = [], cancel = false } = {}) {
    const run = this.#runs.get(handle.providerSessionId);
    if (!run || run.closed) throw Object.assign(new Error("Claude is not waiting for an answer"), { statusCode: 409 });
    const pending = run.inputs.get(requestId);
    if (!pending) throw Object.assign(new Error("This question is missing or already answered"), { statusCode: 409 });
    run.inputs.delete(requestId);
    if (cancel) {
      this.#releaseGuard(run);
      this.#controlResponse(run, pending.controlId, {
        subtype: "success",
        request_id: pending.controlId,
        response: { behavior: "deny", message: "the user skipped the question" },
      });
      return true;
    }
    // Claude reads answers as question-text → string, comma-joined for
    // multi-select, with a separate slot for free text.
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    const structured = {};
    const freeform = [];
    for (const question of Array.isArray(pending.input.questions) ? pending.input.questions : []) {
      const text = clipped(question?.question, 4_000);
      if (!text) continue;
      const answer = byId.get(text) ?? { selected: [] };
      const selected = Array.isArray(answer.selected) ? answer.selected : [];
      const custom = String(answer.custom ?? "").trim();
      const value = selected.length ? selected.join(", ") : custom;
      structured[text] = value;
      if (custom && !selected.length) freeform.push(custom);
    }
    this.#controlResponse(run, pending.controlId, {
      subtype: "success",
      request_id: pending.controlId,
      response: {
        behavior: "allow",
        updatedInput: {
          ...pending.input,
          answers: structured,
          ...(freeform.length ? { response: freeform.join("\n") } : {}),
        },
      },
    });
    this.#releaseGuard(run);
    return true;
  }

  async resolveApproval(handle, approvalId, decision) {
    const run = this.#runs.get(handle.providerSessionId);
    if (!run || run.closed) throw Object.assign(new Error("Claude is not waiting for a decision"), { statusCode: 409 });
    const pending = run.approvals.get(approvalId);
    if (!pending) throw Object.assign(new Error("Approval is missing or already resolved"), { statusCode: 409 });
    run.approvals.delete(approvalId);
    this.#controlResponse(run, pending.controlId, {
      subtype: "success",
      request_id: pending.controlId,
      response: decision === "approve"
        ? { behavior: "allow" }
        : { behavior: "deny", message: "the user denied this call from the phone" },
    });
    this.#releaseGuard(run);
    return true;
  }

  // The guard only matters while something is still unanswered.
  #releaseGuard(run) {
    if (run.inputs.size || run.approvals.size || !run.guardTimer) return;
    clearTimeout(run.guardTimer);
    run.guardTimer = null;
  }

  #controlResponse(run, controlId, body) {
    this.#write(run, { type: "control_response", response: { ...body, request_id: controlId } });
  }

  #write(run, message) {
    if (run.closed || !run.child.stdin?.writable) throw new Error("Claude stdin is closed");
    run.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #currentModelDirectory() {
    try {
      return await this.#modelCatalog?.current();
    } catch {
      return null;
    }
  }
}
