import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeAdapter } from "../src/adapters/claude.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

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
