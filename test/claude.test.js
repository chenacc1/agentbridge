import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeAdapter } from "../src/adapters/claude.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes = [];
  killed = false;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    let pending = "";
    this.stdin.on("data", (chunk) => {
      pending += chunk;
      while (pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line) this.writes.push(JSON.parse(line));
      }
    });
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Claude adapter pins a supported model and observes an early child exit", async () => {
  const child = new FakeChild();
  let receivedArgs;
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 100,
    spawn: (_name, args) => {
      receivedArgs = args;
      queueMicrotask(() => {
        child.stderr.end("model rejected");
        child.stdout.end();
        child.emit("close", 1, null);
      });
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000010");
  const events = [];
  const send = adapter.send(handle, {
    text: "hello",
    emit: async (kind, payload) => {
      events.push({ kind, payload });
      if (kind === "turn.started") await sleep(20);
    },
  }).then(() => "settled");

  const outcome = await Promise.race([send, sleep(150).then(() => "timeout")]);
  assert.equal(outcome, "settled");
  assert.deepEqual(receivedArgs.slice(receivedArgs.indexOf("--model"), receivedArgs.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(events.at(-1)?.payload.error, /model rejected/);
});

test("Claude adapter fails a process that produces no startup output", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 20,
    spawn: () => child,
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000011");
  const events = [];
  const send = adapter.send(handle, {
    text: "hello",
    emit: async (kind, payload) => events.push({ kind, payload }),
  }).then(() => "settled");

  const outcome = await Promise.race([send, sleep(150).then(() => "timeout")]);
  assert.equal(outcome, "settled");
  assert.equal(child.killed, true);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(events.at(-1)?.payload.error, /did not produce output within 20ms/i);
});

test("Claude adapter keeps reading after the first stream event until the child closes", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 100,
    spawn: () => {
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
        })}\n`);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        }, 10);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000012");
  const events = [];
  await adapter.send(handle, { text: "hello", emit: async (kind, payload) => events.push({ kind, payload }) });

  assert.deepEqual(events.map((event) => event.kind), ["turn.started", "message.delta", "message.completed", "turn.completed"]);
  assert.equal(events.find((event) => event.kind === "message.completed")?.payload.text, "OK");
});

test("Claude adapter leaves the provider model untouched without an AgentBridge override", async () => {
  const child = new FakeChild();
  let receivedArgs;
  const adapter = new ClaudeAdapter({
    model: null,
    firstOutputTimeoutMs: 100,
    spawn: (_name, args) => {
      receivedArgs = args;
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000013");
  await adapter.send(handle, { text: "hello", emit: async () => {} });

  assert.equal(receivedArgs.includes("--model"), false);
});

test("Claude adapter applies an allowlisted CC Switch model only to the selected phone session", async () => {
  const child = new FakeChild();
  let receivedArgs;
  const directory = {
    source: "cc-switch",
    current: { provider: "cc-switch:kimi", model: "kimi-for-coding" },
    groups: [{
      id: "cc-switch:kimi",
      name: "Kimi",
      models: [{ id: "kimi-for-coding", name: "K2.7" }, { id: "k3-256k", name: "K3 256K" }],
    }],
  };
  const adapter = new ClaudeAdapter({
    model: null,
    modelCatalog: { current: async () => directory },
    firstOutputTimeoutMs: 100,
    spawn: (_name, args) => {
      receivedArgs = args;
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.start({ cwd: process.cwd() });
  assert.deepEqual(adapter.modelDirectory(handle)?.current, directory.current);
  await adapter.selectModel(handle, { provider: "cc-switch:kimi", model: "k3-256k" });
  await assert.rejects(
    adapter.selectModel(handle, { provider: "cc-switch:deepseek", model: "deepseek-chat" }),
    /not available from the current CC Switch provider/,
  );

  await adapter.send(handle, { text: "hello", emit: async () => {} });
  assert.deepEqual(receivedArgs.slice(receivedArgs.indexOf("--model"), receivedArgs.indexOf("--model") + 2), ["--model", "k3-256k"]);
});

test("Claude adapter does not treat ignored system initialization as assistant output", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "kimi-for-coding",
    firstOutputTimeoutMs: 20,
    spawn: () => {
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`), 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000014");
  const events = [];
  const send = adapter.send(handle, {
    text: "hello",
    emit: async (kind, payload) => events.push({ kind, payload }),
  }).then(() => "settled");

  const outcome = await Promise.race([send, sleep(150).then(() => "timeout")]);
  assert.equal(outcome, "settled");
  assert.equal(child.killed, true);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(events.at(-1)?.payload.error, /did not produce output within 20ms/i);
});

// Claude Code asks the human over its control stream (`can_use_tool`). Before
// this path existed the adapter ran with permission prompts disabled, so the CLI
// deleted AskUserQuestion entirely and the phone could never see a question.
test("Claude AskUserQuestion becomes a phone question answered by question text", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 80,
    spawn: () => {
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: "control_request",
          request_id: "req-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which database should I use?",
                header: "Storage",
                options: [{ label: "SQLite", description: "one file" }, { label: "Postgres", description: "server" }],
                multiSelect: false,
              }],
            },
          },
        })}\n`);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000020");
  const events = [];
  const sending = adapter.send(handle, { text: "go", emit: async (kind, payload) => events.push({ kind, payload }) });

  await sleep(40);
  const requested = events.find((event) => event.kind === "input.requested");
  assert.ok(requested, "the question never reached the phone");
  assert.equal(requested.payload.questions[0].id, "Which database should I use?");
  assert.deepEqual(requested.payload.questions[0].options.map((option) => option.label), ["SQLite", "Postgres"]);

  await adapter.resolveInput(handle, requested.payload.requestId, {
    answers: [{ id: "Which database should I use?", selected: ["SQLite"] }],
  });
  const answer = child.writes.find((message) => message.type === "control_response");
  assert.ok(answer, "no control response was written back to Claude");
  assert.equal(answer.response.request_id, "req-1");
  assert.equal(answer.response.response.behavior, "allow");
  assert.deepEqual(answer.response.response.updatedInput.answers, { "Which database should I use?": "SQLite" });

  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`);
  child.emit("close", 0, null);
  await sending;
  assert.equal(events.at(-1).kind, "turn.completed");
});

test("a pending Claude question does not trip the first-output watchdog", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 20,
    spawn: () => {
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: "control_request",
          request_id: "req-2",
          request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes" }, { label: "no" }] }] } },
        })}\n`);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000021");
  const events = [];
  const sending = adapter.send(handle, { text: "go", emit: async (kind, payload) => events.push({ kind, payload }) });

  await sleep(60);
  assert.equal(events.some((event) => event.kind === "turn.failed"), false, "the watchdog killed a turn that was waiting for the human");
  const requested = events.find((event) => event.kind === "input.requested");
  await adapter.resolveInput(handle, requested.payload.requestId, { answers: [], cancel: true });
  const deny = child.writes.find((message) => message.type === "control_response");
  assert.equal(deny.response.response.behavior, "deny");
  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "skipped" })}\n`);
  child.emit("close", 0, null);
  await sending;
});

test("Claude tool approvals reach the phone and an unknown control request is refused", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 80,
    spawn: () => {
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({ type: "control_request", request_id: "req-3", request: { subtype: "some_future_request" } })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: "control_request",
          request_id: "req-4",
          request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" } },
        })}\n`);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000022");
  const events = [];
  const sending = adapter.send(handle, { text: "clean up", emit: async (kind, payload) => events.push({ kind, payload }) });

  await sleep(40);
  const refusal = child.writes.find((message) => message.type === "control_response" && message.response.subtype === "error");
  assert.ok(refusal, "an unanswerable control request must be refused rather than left waiting");
  assert.equal(refusal.response.request_id, "req-3");

  const approval = events.find((event) => event.kind === "approval.requested");
  assert.ok(approval, "the tool approval never reached the phone");
  assert.equal(approval.payload.method, "Bash");
  assert.equal(approval.payload.request.command, "rm -rf build");

  await adapter.resolveApproval(handle, approval.payload.approvalId, "deny");
  const decision = child.writes.find((message) => message.type === "control_response" && message.response.request_id === "req-4");
  assert.equal(decision.response.response.behavior, "deny");
  assert.match(decision.response.response.message, /denied/);

  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
  child.emit("close", 0, null);
  await sending;
});

// A prompt nobody can answer must not park the turn: Claude keeps the tool call
// open until the host replies, so the adapter denies it after a bounded wait.
test("an unanswered Claude prompt is denied instead of hanging the turn", async () => {
  const child = new FakeChild();
  const adapter = new ClaudeAdapter({
    model: "sonnet",
    firstOutputTimeoutMs: 80,
    interactionTimeoutMs: 40,
    spawn: () => {
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: "control_request",
          request_id: "req-expire",
          request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes" }, { label: "no" }] }] } },
        })}\n`);
      }, 5);
      return child;
    },
  });
  const handle = await adapter.attach({ cwd: process.cwd() }, "00000000-0000-4000-8000-000000000030");
  const events = [];
  const sending = adapter.send(handle, { text: "go", emit: async (kind, payload) => events.push({ kind, payload }) });

  await sleep(40);
  const requested = events.find((event) => event.kind === "input.requested");
  assert.ok(requested);
  await sleep(60);

  const deny = child.writes.find((message) => message.type === "control_response");
  assert.ok(deny, "the unanswered prompt was never released");
  assert.equal(deny.response.request_id, "req-expire");
  assert.equal(deny.response.response.behavior, "deny");
  const retired = events.find((event) => event.kind === "input.resolved");
  assert.ok(retired, "the phone card was never retired");
  assert.equal(retired.payload.outcome, "expired");
  await assert.rejects(
    adapter.resolveInput(handle, requested.payload.requestId, { answers: [] }),
    /missing or already answered/,
  );

  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "gave up" })}\n`);
  child.emit("close", 0, null);
  await sending;
  assert.equal(events.at(-1).kind, "turn.completed");
});

