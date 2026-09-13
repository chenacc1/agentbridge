import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAdapter } from "../src/adapters/codex.js";

class FakeAppServer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests = [];

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
        if (line) this.#handle(JSON.parse(line));
      }
    });
    setImmediate(() => this.emit("spawn"));
  }

  kill() {
    this.emit("exit", 0, null);
    return true;
  }

  #respond(id, result) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  #handle(message) {
    if (!message.id) return;
    this.requests.push(message);
    if (message.method === "initialize") return this.#respond(message.id, {});
    if (message.method === "model/list") {
      return this.#respond(message.id, { data: [{
        id: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
        ],
      }] });
    }
    if (message.method === "thread/start") return this.#respond(message.id, { thread: { id: "codex-thread-123" } });
    if (message.method === "thread/resume") return this.#respond(message.id, { thread: { id: message.params.threadId } });
    if (message.method === "turn/start") return this.#respond(message.id, { turn: { id: "turn-123" } });
    return this.#respond(message.id, {});
  }
}

test("Codex adapter exposes the live model catalog and applies an allowlisted model and effort per phone turn", async () => {
  const child = new FakeAppServer();
  const adapter = new CodexAdapter({
    spawn: () => child,
    probe: async () => ({ available: true }),
  });
  const handle = await adapter.start({ cwd: process.cwd() });

  assert.deepEqual(adapter.modelDirectory(handle), {
    source: "codex-app-server",
    routable: true,
    current: null,
    groups: [{
      id: "openai",
      name: "OpenAI Codex",
      models: [{
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: { efforts: [{ id: "low", name: "Fast" }, { id: "high", name: "Deep" }] },
      }],
    }],
    failures: [],
  });

  await adapter.selectModel(handle, { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "high" });
  await adapter.send(handle, { text: "Hello", emit: async () => {}, commandId: "codex-model-test" });
  const turn = child.requests.find((request) => request.method === "turn/start");
  assert.equal(turn.params.model, "gpt-5.6-terra");
  assert.equal(turn.params.effort, "high");
  await assert.rejects(
    adapter.selectModel(handle, { provider: "openai", model: "not-available" }),
    /not available from this Codex model directory/,
  );
  await assert.rejects(
    adapter.selectModel(handle, { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "xhigh" }),
    /not supported by this Codex model/,
  );
});
