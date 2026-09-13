import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../integrations/dsh-phone/lib/index.js";

test("/phone reads the live DSH model directory even when agent.options omits provider and model", async (t) => {
  let command;
  let disposed;
  let modelsCalls = 0;
  const registrations = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/register")) {
      registrations.push(JSON.parse(options.body));
      return Response.json({
        channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: "test-token" },
        pairing: { url: "http://127.0.0.1:8787/pair?code=test" },
        project: { cwd: "D:\\work" },
        qrImageUrl: "http://127.0.0.1:8787/qr.svg",
      });
    }
    return Response.json({ commands: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  apply({
    on(name, listener) {
      if (name === "agent/disposed") disposed = listener;
    },
    commands: { register(value) { command = value; } },
    apiProxy: {
      sessions: {
        async models({ payload }) {
          modelsCalls += 1;
          assert.equal(payload.sessionId, "dsh-session-without-options");
          return {
            result: {
              ok: true,
              value: {
                current: { provider: "deepseek", model: "deepseek-chat" },
                routable: true,
                groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] }],
                failures: [],
              },
            },
          };
        },
      },
    },
    logger: { warn() {} },
  });

  const agent = {
    session: { id: "dsh-session-without-options", header: { cwd: "D:\\work", title: "Untitled" } },
    options: {},
  };
  await command.handler({ agent });
  disposed({ agent });

  assert.equal(modelsCalls, 1);
  assert.deepEqual(registrations[0].modelDirectory.current, { provider: "deepseek", model: "deepseek-chat" });
});

test("/phone falls back to the host catalog and switches the held live agent when session lookup misses", async (t) => {
  let command;
  let disposed;
  let pollCount = 0;
  let finishResult;
  const commandResult = new Promise((resolve) => { finishResult = resolve; });
  const registrations = [];
  const agentHooks = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      registrations.push(JSON.parse(options.body));
      return Response.json({
        channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: "test-token" },
        pairing: { url: "http://127.0.0.1:8787/pair?code=test" },
        project: { cwd: "D:\\work" },
        qrImageUrl: "http://127.0.0.1:8787/qr.svg",
      });
    }
    if (target.includes("/poll")) {
      pollCount += 1;
      return Response.json({ commands: pollCount === 1 ? [{
        seq: 1,
        kind: "select-model",
        requestId: "model-request-1",
        selection: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" },
      }] : [] });
    }
    if (target.endsWith("/results")) {
      finishResult(JSON.parse(options.body).result);
      return Response.json({ accepted: true });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const missing = (rpcId) => ({
    rpcId,
    result: { ok: false, error: { code: "session-not-found", message: "live UI session is not in the API registry", details: {} } },
  });
  apply({
    on(name, listener) {
      if (name === "agent/disposed") disposed = listener;
    },
    commands: { register(value) { command = value; } },
    apiProxy: {
      sessions: {
        async models({ rpcId }) { return missing(rpcId); },
        async selectModel({ rpcId }) { return missing(rpcId); },
      },
      llm: {
        async models({ rpcId }) {
          return {
            rpcId,
            result: {
              ok: true,
              value: {
                groups: [{
                  id: "deepseek-official",
                  name: "DeepSeek",
                  models: [{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", reasoning: { efforts: [{ id: "high", name: "High" }] } }],
                }],
                failures: [],
              },
            },
          };
        },
      },
    },
    llm: {
      async resolveCallConfig(selection) { return selection; },
    },
    logger: { warn() {} },
  });

  const agent = {
    session: {
      id: "dsh-live-ui-session",
      header: { cwd: "D:\\work", title: "Live UI session" },
      requestHeader() { return { config: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" } }; },
    },
    options: {},
    ctx: {
      on(name, listener) {
        agentHooks.set(name, listener);
        return () => agentHooks.delete(name);
      },
    },
  };
  await command.handler({ agent });
  const result = await Promise.race([
    commandResult,
    new Promise((_, reject) => setTimeout(() => reject(new Error("model result timeout")), 2_000)),
  ]);
  disposed({ agent });

  assert.deepEqual(registrations[0].modelDirectory.current, {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.equal(registrations[0].modelDirectory.groups[0].models[0].id, "deepseek-v4-pro");
  assert.deepEqual(result, {
    ok: true,
    selected: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" },
  });
  const assembled = await agentHooks.get("system-prompt/assemble")({}, {}, async () => ({ variables: {} }));
  assert.deepEqual(assembled.variables, { provider: "deepseek-official", model: "deepseek-v4-pro" });
  const request = await agentHooks.get("agent/request")({}, async () => ({ provider: "old", model: "old", reasoningEffort: "low" }));
  assert.deepEqual(request, { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" });
});
