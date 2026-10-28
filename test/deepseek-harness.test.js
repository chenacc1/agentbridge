import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { DeepSeekHarnessAdapter, acpUpdateToEvent } from "../src/adapters/deepseek-harness.js";
import { ZCodeNativeAdapter } from "../src/adapters/zcode-native.js";

class FakeAcpChild extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(chunk.toString("utf8"));
        this.frames.push(message);
        this.#respond(message);
        callback();
      },
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  kill() {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }

  #write(message) {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  #respond(message) {
    if (message.method === "initialize") {
      this.#write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    }
    if (message.method === "session/new") {
      this.#write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "dsh-session-1" } });
      return;
    }
    if (message.method === "session/resume") {
      this.#write({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
      return;
    }
    if (message.method === "session/prompt") {
      this.#write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Harness OK" } },
        },
      });
      this.#write({
        jsonrpc: "2.0",
        id: "permission-request-1",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "write file", kind: "edit" },
          options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
        },
      });
      this.#write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}

test("DeepSeek Harness adapter speaks ACP, maps committed messages, and returns approval decisions", async () => {
  let child;
  const adapter = new DeepSeekHarnessAdapter({
    probe: async () => ({ available: true, version: "test" }),
    spawnProcess: () => {
      child = new FakeAcpChild();
      return child;
    },
  });
  const availability = await adapter.detect();
  assert.equal(availability.supported, true);
  assert.match(availability.docsUrl, /deepseek-harness/);
  const handle = await adapter.start({ cwd: "D:\\work" });
  assert.equal(handle.providerSessionId, "dsh-session-1");
  assert.deepEqual(child.frames.slice(0, 2).map((frame) => frame.method), ["initialize", "session/new"]);
  assert.deepEqual(child.frames[1].params, { cwd: "D:\\work", additionalDirectories: [], mcpServers: [] });

  const events = [];
  await adapter.send(handle, {
    text: "hello",
    emit: async (kind, payload, extra) => events.push({ kind, payload, extra }),
  });
  assert.deepEqual(events.map((event) => event.kind), [
    "turn.started",
    "message.started",
    "message.delta",
    "approval.requested",
    "message.completed",
    "turn.completed",
  ]);
  assert.equal(events.find((event) => event.kind === "message.completed").payload.text, "Harness OK");

  const approval = events.find((event) => event.kind === "approval.requested").payload.approvalId;
  await adapter.resolveApproval(handle, approval, "approve");
  const decision = child.frames.at(-1);
  assert.deepEqual(decision.result, { outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("ACP update mapper exposes standard text and tool semantics", () => {
  assert.deepEqual(
    acpUpdateToEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }),
    { kind: "message.delta", payload: { role: "assistant", text: "Hi" } },
  );
  assert.equal(acpUpdateToEvent({ sessionUpdate: "plan", entries: [] }), null);
});

test("ZCode is explicitly a native handoff, not a createable bridge adapter", async () => {
  const adapter = new ZCodeNativeAdapter({ probe: async () => ({ available: false, version: null }) });
  const availability = await adapter.detect();
  assert.equal(availability.supported, false);
  assert.equal(availability.native, true);
  assert.match(availability.docsUrl, /zcode\.z\.ai/);
  await assert.rejects(adapter.start(), /native Remote Control/);
});

// ACP asks the human with `elicitation/create` form mode. Without this the
// request fell into the -32601 branch, so an ACP-backed agent could not ask and
// the phone showed nothing.
test("ACP elicitation becomes a phone question and answers with typed content", async () => {
  let child;
  const adapter = new DeepSeekHarnessAdapter({
    probe: async () => ({ available: true, version: "test" }),
    spawnProcess: () => {
      child = new FakeAcpChild();
      return child;
    },
  });
  const handle = await adapter.start({ cwd: "D:\\work" });
  const events = [];
  handle.emit = async (kind, payload) => events.push({ kind, payload });

  // ACP requires each mode to be advertised explicitly before an agent may ask.
  assert.deepEqual(child.frames[0].params.clientCapabilities, { elicitation: { form: {} } });

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "elicitation-1",
    method: "elicitation/create",
    params: {
      sessionId: "dsh-session-1",
      mode: "form",
      message: "How should I approach this refactoring?",
      requestedSchema: {
        type: "object",
        properties: {
          strategy: { type: "string", enum: ["conservative", "balanced", "aggressive"], title: "Strategy" },
          note: { type: "string", title: "Note" },
          dryRun: { type: "boolean", title: "Dry run" },
        },
        required: ["strategy"],
      },
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const requested = events.find((event) => event.kind === "input.requested");
  assert.ok(requested, "the elicitation never reached the phone");
  const byId = new Map(requested.payload.questions.map((question) => [question.id, question]));
  assert.deepEqual(byId.get("strategy").options.map((option) => option.label), ["conservative", "balanced", "aggressive"]);
  assert.equal(byId.get("strategy").header, "Strategy");
  assert.match(byId.get("strategy").question, /How should I approach this refactoring/);
  assert.deepEqual(byId.get("dryRun").options.map((option) => option.label), ["是", "否"]);

  await adapter.resolveInput(handle, requested.payload.requestId, {
    answers: [
      { id: "strategy", selected: ["balanced"] },
      { id: "dryRun", selected: ["是"] },
    ],
  });
  const reply = child.frames.find((frame) => frame.id === "elicitation-1" && frame.result);
  assert.deepEqual(reply.result, { action: "accept", content: { strategy: "balanced", dryRun: true } });

  await assert.rejects(
    adapter.resolveInput(handle, requested.payload.requestId, { answers: [] }),
    /missing or already answered/,
  );
});

test("a required ACP field or a URL elicitation is refused instead of hanging", async () => {
  let child;
  const adapter = new DeepSeekHarnessAdapter({
    probe: async () => ({ available: true, version: "test" }),
    spawnProcess: () => {
      child = new FakeAcpChild();
      return child;
    },
  });
  const handle = await adapter.start({ cwd: "D:\\work" });
  const events = [];
  handle.emit = async (kind, payload) => events.push({ kind, payload });

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "elicitation-2",
    method: "elicitation/create",
    params: {
      sessionId: "dsh-session-1",
      mode: "form",
      message: "Pick a branch",
      requestedSchema: { type: "object", properties: { branch: { type: "string", title: "Branch" } }, required: ["branch"] },
    },
  })}\n`);
  // Only form mode is advertised, so a URL hand-off must be declined at once.
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "elicitation-url",
    method: "elicitation/create",
    params: { requestId: 12, mode: "url", elicitationId: "oauth-1", url: "https://example.com/connect", message: "Authorize" },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const urlReply = child.frames.find((frame) => frame.id === "elicitation-url" && frame.result);
  assert.deepEqual(urlReply.result, { action: "decline" });

  const requested = events.find((event) => event.kind === "input.requested");
  await assert.rejects(
    adapter.resolveInput(handle, requested.payload.requestId, { answers: [] }),
    /requires an answer/,
  );
  await adapter.resolveInput(handle, requested.payload.requestId, { answers: [], cancel: true });
  const decline = child.frames.find((frame) => frame.id === "elicitation-2" && frame.result);
  assert.deepEqual(decline.result, { action: "decline" });
});
