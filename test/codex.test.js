import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CodexAdapter } from "../src/adapters/codex.js";

class FakeAppServer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests = [];
  killed = false;

  constructor({ threadPages = new Map(), threadListError = null } = {}) {
    super();
    this.threadPages = threadPages;
    this.threadListError = threadListError;
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
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  #respond(id, result) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  #reject(id, message) {
    this.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`);
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
    if (message.method === "thread/list") {
      if (this.threadListError) return this.#reject(message.id, this.threadListError);
      return this.#respond(message.id, this.threadPages.get(message.params.cursor ?? null) ?? { data: [], nextCursor: null });
    }
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

test("Codex adapter discovers every public thread page for exactly one workspace", async () => {
  const workspacePath = path.resolve(process.cwd());
  const child = new FakeAppServer({
    threadPages: new Map([
      [null, {
        data: [{
          id: "codex-thread-a",
          name: "Workspace title",
          preview: "Ignored preview",
          cwd: workspacePath,
          createdAt: 1_735_000_000,
          updatedAt: 1_735_000_100,
          source: "appServer",
          status: { type: "notLoaded" },
        }],
        nextCursor: "page-two",
      }],
      ["page-two", {
        data: [
          {
            id: "codex-thread-b",
            name: null,
            preview: "Fallback preview",
            cwd: workspacePath,
            createdAt: 1_734_000_000,
            updatedAt: 1_734_000_200,
            source: "cli",
            status: { type: "idle" },
          },
          {
            id: "foreign-thread",
            name: "Another workspace",
            preview: "Must not leak",
            cwd: path.dirname(workspacePath),
            createdAt: 1_733_000_000,
            updatedAt: 1_733_000_100,
            source: "cli",
            status: { type: "notLoaded" },
          },
        ],
        nextCursor: null,
      }],
    ]),
  });
  const adapter = new CodexAdapter({ spawn: () => child, probe: async () => ({ available: true }) });

  const discovery = await adapter.discoverConversations({
    workspace: { id: "ws_demo", alias: "demo", canonicalPath: workspacePath },
  });

  assert.equal(adapter.capabilities.discover, true);
  assert.deepEqual(discovery.conversations, [
    {
      providerConversationId: "codex-thread-a",
      title: "Workspace title",
      createdAt: new Date(1_735_000_000 * 1000).toISOString(),
      lastActiveAt: new Date(1_735_000_100 * 1000).toISOString(),
    },
    {
      providerConversationId: "codex-thread-b",
      title: "Fallback preview",
      createdAt: new Date(1_734_000_000 * 1000).toISOString(),
      lastActiveAt: new Date(1_734_000_200 * 1000).toISOString(),
    },
  ]);
  assert.deepEqual(discovery.diagnostics, {
    status: "available",
    protocol: "codex-app-server/thread-list-v2",
    pages: 2,
  });
  const listRequests = child.requests.filter((request) => request.method === "thread/list");
  assert.equal(listRequests.length, 2);
  assert.deepEqual(listRequests[0].params, {
    cursor: null,
    limit: 100,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: ["cli", "vscode", "appServer"],
    archived: false,
    cwd: workspacePath,
  });
  assert.equal(listRequests[1].params.cursor, "page-two");
  assert.equal(child.killed, true, "discovery must not leave a provider process running");
});

test("Codex adapter reports thread/list protocol mismatches as degraded discovery", async () => {
  const child = new FakeAppServer({ threadListError: "Method not found: thread/list" });
  const adapter = new CodexAdapter({ spawn: () => child, probe: async () => ({ available: true }) });

  await assert.rejects(
    adapter.discoverConversations({ workspace: { canonicalPath: path.resolve(process.cwd()) } }),
    (error) => error.statusCode === 501
      && error.code === "ADAPTER_DISCOVERY_UNAVAILABLE"
      && error.diagnostics?.status === "degraded",
  );
  assert.equal(child.killed, true);
});
