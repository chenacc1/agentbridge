import test from "node:test";
import assert from "node:assert/strict";
import { PhoneConnections, apply, interactionRecord } from "../integrations/dsh-phone/lib/index.js";

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

test("DSH interaction frames are projected to this session only", () => {
  const questions = interactionRecord({
    rpcId: "rpc-1",
    payload: {
      type: "question/requested",
      sessionId: "dsh-session-a",
      questions: [{
        id: "mode",
        header: "Choose Mode",
        question: "Which storage?",
        options: [{ label: "SQLite", description: "single file" }, { label: "Postgres" }],
        multiSelect: true,
      }],
    },
  }, "dsh-session-a");
  assert.equal(questions.kind, "question-requested");
  assert.equal(questions.requestId, "rpc-1");
  assert.deepEqual(questions.questions[0].options, [
    { label: "SQLite", description: "single file" },
    { label: "Postgres" },
  ]);
  assert.equal(questions.questions[0].multiSelect, true);

  assert.equal(interactionRecord({ rpcId: "rpc-1", payload: { type: "question/requested", sessionId: "other", questions: [{ question: "x" }] } }, "dsh-session-a"), null);
  assert.equal(interactionRecord({ rpcId: "rpc-1", payload: { type: "session/event", sessionId: "dsh-session-a" } }, "dsh-session-a"), null);

  const approval = interactionRecord({
    rpcId: "rpc-2",
    payload: { type: "approval/requested", sessionId: "dsh-session-a", approvalId: "approval-1", toolName: "bash", reason: "network access", callId: "call-1" },
  }, "dsh-session-a");
  assert.deepEqual(approval, {
    kind: "approval-requested",
    requestId: "rpc-2",
    dshApprovalId: "approval-1",
    toolName: "bash",
    reason: "network access",
    callId: "call-1",
  });

  const resolved = interactionRecord({
    rpcId: "rpc-3",
    payload: { type: "question/resolved", sessionId: "dsh-session-a", questionRpcId: "rpc-1", outcome: "answered" },
  }, "dsh-session-a");
  assert.deepEqual(resolved, { kind: "question-resolved", requestId: "rpc-1", outcome: "answered" });
});

test("/phone relays a DSH question and approval to AgentBridge and answers them", async (t) => {
  let command;
  let disposed;
  const interactions = [];
  const results = [];
  const responded = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      return Response.json({
        channel: {
          id: "channel-1",
          pollPath: "/poll",
          eventsPath: "/events",
          interactionsPath: "/interactions",
          resultsPath: "/results",
          token: "test-token",
        },
        pairing: { url: "http://127.0.0.1:8787/pair?code=test" },
        project: { cwd: "D:\\work" },
        qrImageUrl: "http://127.0.0.1:8787/qr.svg",
      });
    }
    if (target.endsWith("/interactions")) {
      interactions.push(...JSON.parse(options.body).interactions);
      return Response.json({ handled: 1 });
    }
    if (target.includes("/poll")) {
      return Response.json({
        commands: polled
          ? []
          : [
            { seq: 1, kind: "answer-question", requestId: "bridge-question-1", rpcId: "rpc-question", answers: [{ id: "mode", selected: ["SQLite"] }] },
            { seq: 2, kind: "answer-approval", requestId: "bridge-approval-1", rpcId: "rpc-approval", dshApprovalId: "approval-1", outcome: "allowed-once" },
          ],
      });
    }
    if (target.endsWith("/results")) {
      results.push(JSON.parse(options.body));
      return Response.json({ accepted: true });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  let polled = false;

  apply({
    on(name, listener) {
      if (name === "agent/disposed") disposed = listener;
    },
    commands: { register(value) { command = value; } },
    apiProxy: {
      sessions: {
        async models({ rpcId }) {
          return { rpcId, result: { ok: false, error: { code: "session-not-found", message: "no live UI session", details: {} } } };
        },
      },
      llm: {
        async models({ rpcId }) {
          return { rpcId, result: { ok: true, value: { groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] }], failures: [] } } };
        },
      },
      events: {
        async *mux(_request, signal) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          yield {
            rpcId: "rpc-question",
            payload: {
              type: "question/requested",
              sessionId: "dsh-session-interactions",
              questions: [{ id: "mode", question: "Which storage?", options: [{ label: "SQLite" }] }],
            },
          };
          yield {
            rpcId: "rpc-approval",
            payload: { type: "approval/requested", sessionId: "dsh-session-interactions", approvalId: "approval-1", toolName: "bash" },
          };
          // A different conversation's question must never reach this bridge session.
          yield {
            rpcId: "rpc-foreign",
            payload: { type: "question/requested", sessionId: "another-session", questions: [{ id: "x", question: "foreign" }] },
          };
          await new Promise((resolve) => setTimeout(resolve, 120));
          // DSH's echo of an answer this phone already gave stays off the wire.
          yield {
            rpcId: "rpc-echo",
            payload: { type: "question/resolved", sessionId: "dsh-session-interactions", questionRpcId: "rpc-question", outcome: "answered" },
          };
          while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
      respond(message) {
        responded.push(message);
        return Promise.resolve({ accepted: true });
      },
    },
    llm: { async resolveCallConfig(selection) { return selection; } },
    logger: { warn() {} },
  });

  const agent = {
    session: { id: "dsh-session-interactions", header: { cwd: "D:\\work", title: "Live" }, requestHeader() { return { config: { provider: "deepseek", model: "deepseek-chat" } }; } },
    options: { provider: "deepseek", model: "deepseek-chat" },
    ctx: { on() { return () => {}; } },
  };
  await command.handler({ agent });
  polled = true;

  const deadline = Date.now() + 5_000;
  const settled = async () => interactions.length >= 2 && results.length >= 2 && responded.length >= 2;
  while (!settled() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 240));
  disposed({ agent });

  assert.deepEqual(interactions.map((record) => record.kind), ["question-requested", "approval-requested"]);
  assert.equal(interactions[0].questions[0].question, "Which storage?");
  assert.deepEqual(responded, [
    {
      type: "client-response",
      rpcId: "rpc-question",
      result: { ok: true, value: { sessionId: "dsh-session-interactions", answer: { answers: [{ id: "mode", selected: ["SQLite"] }] } } },
    },
    {
      type: "client-response",
      rpcId: "rpc-approval",
      result: { ok: true, value: { sessionId: "dsh-session-interactions", approvalId: "approval-1", outcome: "allowed-once" } },
    },
  ]);
  assert.deepEqual(results.map((entry) => entry.result), [{ ok: true }, { ok: true }]);
});

test("a create-session command opens a real DSH conversation and registers it against the phone's session", async (t) => {
  let command;
  let disposed;
  let pollCount = 0;
  let finishResult;
  const commandResult = new Promise((resolve) => { finishResult = resolve; });
  const registrations = [];
  const created = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      registrations.push(JSON.parse(options.body));
      return Response.json({
        created: true,
        sessionId: JSON.parse(options.body).bridgeSessionId,
        channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: "test-token" },
        project: { cwd: "D:\\work" },
      });
    }
    if (target.includes("/poll")) {
      pollCount += 1;
      return Response.json({ commands: pollCount === 1 ? [{
        seq: 1,
        kind: "create-session",
        requestId: "create-request-1",
        bridgeSessionId: "bs_pending_session",
        cwd: "D:\\projects\\new-app",
      }] : [] });
    }
    if (target.endsWith("/results")) {
      finishResult(JSON.parse(options.body).result);
      return Response.json({ accepted: true });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  apply({
    on(name, listener) {
      if (name === "agent/disposed") disposed = listener;
    },
    commands: { register(value) { command = value; } },
    apiProxy: {
      sessions: {
        async models({ rpcId }) {
          return { rpcId, result: { ok: true, value: { current: { provider: "ds", model: "ds-chat" }, routable: true, groups: [], failures: [] } } };
        },
      },
    },
    agents: {
      async create(options) {
        created.push(options);
        return {
          agent: {
            session: { id: options.sessionId, header: { cwd: options.meta.cwd, title: "手机新建" } },
            options: { provider: "ds", model: "ds-chat" },
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        };
      },
    },
    logger: { warn() {} },
  });

  const carrier = {
    session: { id: "dsh-carrier-session", header: { cwd: "D:\\work", title: "Carrier" } },
    options: { provider: "ds", model: "ds-chat" },
  };
  await command.handler({ agent: carrier });
  const result = await Promise.race([
    commandResult,
    new Promise((_, reject) => setTimeout(() => reject(new Error("create result timeout")), 2_000)),
  ]);
  disposed({ agent: carrier });
  // The created conversation opened its own connection; close it too so the test
  // process has nothing left to poll.
  disposed({ agent: { session: { id: created[0].sessionId } } });

  assert.equal(created.length, 1);
  assert.equal(created[0].meta.cwd, "D:\\projects\\new-app");
  assert.match(created[0].sessionId, /^session-/);
  assert.deepEqual(created[0].agentOptions, { provider: "ds", model: "ds-chat" });
  // The new conversation registers against the session the phone already opened,
  // which is how the bridge binds it instead of minting a second pairing.
  assert.equal(registrations.at(-1).bridgeSessionId, "bs_pending_session");
  assert.equal(registrations.at(-1).sessionId, created[0].sessionId);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, created[0].sessionId);
});

test("a create-session command reports why the desktop build cannot create rather than failing silently", async (t) => {
  let command;
  let disposed;
  let pollCount = 0;
  let finishResult;
  const commandResult = new Promise((resolve) => { finishResult = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      return Response.json({ channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: "t" }, project: { cwd: "D:\\work" } });
    }
    if (target.includes("/poll")) {
      pollCount += 1;
      return Response.json({ commands: pollCount === 1 ? [{
        seq: 1, kind: "create-session", requestId: "create-request-2", bridgeSessionId: "bs_pending", cwd: "D:\\work",
      }] : [] });
    }
    if (target.endsWith("/results")) {
      finishResult(JSON.parse(options.body).result);
      return Response.json({ accepted: true });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  apply({
    on(name, listener) { if (name === "agent/disposed") disposed = listener; },
    commands: { register(value) { command = value; } },
    apiProxy: { sessions: { async models({ rpcId }) { return { rpcId, result: { ok: true, value: { current: null, groups: [], failures: [] } } }; } } },
    logger: { warn() {} },
  });

  const carrier = { session: { id: "dsh-carrier-session", header: { cwd: "D:\\work", title: "Carrier" } }, options: {} };
  await command.handler({ agent: carrier });
  const result = await Promise.race([
    commandResult,
    new Promise((_, reject) => setTimeout(() => reject(new Error("create result timeout")), 2_000)),
  ]);
  disposed({ agent: carrier });

  assert.equal(result.ok, false);
  assert.match(result.error, /ctx\.agents\.create/);
});
test("a bridge that forgot the channel makes the integration re-register instead of going quiet", async (t) => {
  let command;
  let disposed;
  const registrations = [];
  let pollCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      registrations.push(JSON.parse(options.body));
      return Response.json({
        channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: `token-${registrations.length}` },
        ...(registrations.length === 1 ? { pairing: { url: "http://127.0.0.1:8787/pair?code=x" }, project: { cwd: "D:\\work" } } : { reconnected: true, project: { cwd: "D:\\work" } }),
      });
    }
    if (target.includes("/poll")) {
      pollCount += 1;
      // The first channel is stale: exactly what a bridge restart looks like.
      if (pollCount === 1) return Response.json({ error: "Invalid DSH Desktop channel" }, { status: 401 });
      return Response.json({ commands: [] });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  apply({
    on(name, listener) { if (name === "agent/disposed") disposed = listener; },
    commands: { register(value) { command = value; } },
    apiProxy: { sessions: { async models({ rpcId }) { return { rpcId, result: { ok: true, value: { current: { provider: "ds", model: "ds-chat" }, routable: true, groups: [], failures: [] } } }; } } },
    logger: { warn() {} },
  });

  const agent = { session: { id: "dsh-reconnect-session", header: { cwd: "D:\\work", title: "重连" } }, options: { provider: "ds", model: "ds-chat" } };
  await command.handler({ agent });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && registrations.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  disposed({ agent });

  assert.equal(registrations.length, 2, `expected a re-registration, got ${registrations.length}`);
  assert.equal(registrations[0].reconnect, undefined, "the first registration is not a reconnect");
  assert.equal(registrations[1].reconnect, true, "the reconnect has to be marked as such");
  assert.equal(registrations[1].sessionId, registrations[0].sessionId);
});

// Stopping the bridge by hand and starting it again is slower than the six attempts the
// integration used to allow, and every attempt costs a round-trip that tears the old
// channel down first. The conversation must still come back on its own afterwards.
test("a bridge that stays down for a while is still reconnected, without a /phone in between", async (t) => {
  const OUTAGE_ATTEMPTS = 9;
  let registrations = 0;
  let reconnectAttempts = 0;
  let pollCount = 0;
  const warnings = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      registrations += 1;
      const body = JSON.parse(options.body);
      if (body.reconnect === true) {
        reconnectAttempts += 1;
        // The bridge is still coming up: this is the window that used to be fatal.
        if (reconnectAttempts <= OUTAGE_ATTEMPTS) throw new Error("fetch failed");
      }
      return Response.json({
        channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: `token-${registrations}` },
        ...(body.reconnect === true ? { reconnected: true } : { pairing: { url: "http://127.0.0.1:8787/pair?code=x" } }),
        project: { cwd: "D:\\work" },
      });
    }
    if (target.includes("/poll")) {
      pollCount += 1;
      // Only the very first channel is stale: one bridge restart.
      if (pollCount === 1) return Response.json({ error: "Invalid DSH Desktop channel" }, { status: 401 });
      return Response.json({ commands: [] });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const connections = new PhoneConnections({
    on() {},
    commands: { register() {} },
    apiProxy: { sessions: { async models({ rpcId }) { return { rpcId, result: { ok: true, value: { current: { provider: "ds", model: "ds-chat" }, routable: true, groups: [], failures: [] } } }; } } },
    logger: { warn(message) { warnings.push(String(message)); } },
  }, { reconnectMinMs: 1, reconnectMaxMs: 2 });

  const agent = { session: { id: "dsh-long-outage", header: { cwd: "D:\\work", title: "长时间停机" } }, options: { provider: "ds", model: "ds-chat" } };
  await connections.connect(agent);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !warnings.some((line) => line.includes("reconnected"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const title = "长时间停机";
  connections.dispose(agent.session.id);

  assert.ok(reconnectAttempts > OUTAGE_ATTEMPTS, `expected the integration to keep retrying past ${OUTAGE_ATTEMPTS} failures, saw ${reconnectAttempts}`);
  assert.ok(
    warnings.some((line) => line.includes(`reconnected "${title}"`)),
    `expected a reconnected line, saw ${JSON.stringify(warnings)}`,
  );
  // A long outage must not fill the desktop log: one line per attempt, or every tenth.
  const attemptLines = warnings.filter((line) => line.includes("reconnect attempt"));
  assert.ok(attemptLines.length <= 3, `expected rate-limited reconnect logging, saw ${attemptLines.length} lines`);
});

// The desktop log used to fill with `event sync failed: Request body is too large`
// in a loop: one giant tool output wedged the 200-item batch behind itself, and every
// replay of that batch was refused again. The channel must keep making progress no
// matter how large one event is.
test("an oversized event is shrunken so the batch the bridge refuses never happens", async (t) => {
  const sent = [];
  let eventListener;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      return Response.json({ channel: { pollPath: "/poll", eventsPath: "/events", resultsPath: "/results", token: "test-token" }, pairing: { url: "x" }, project: { cwd: "D:\\work" } });
    }
    if (target.includes("/events")) {
      sent.push(options.body);
      return Response.json({ accepted: true });
    }
    return Response.json({ commands: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const connections = new PhoneConnections({
    on(name, listener) { if (name === "session/event") eventListener = listener; },
    commands: { register() {} },
    apiProxy: { sessions: { async models({ rpcId }) { return { rpcId, result: { ok: true, value: { current: { provider: "ds", model: "ds-chat" }, routable: true, groups: [], failures: [] } } }; } } },
    logger: { warn() {} },
  });

  const agent = { session: { id: "dsh-oversized", header: { cwd: "D:\\work", title: "大事件" } }, options: { provider: "ds", model: "ds-chat" } };
  await connections.connect(agent);
  const session = { id: "dsh-oversized" };

  const giant = { type: "tool.completed", seq: 1, time: 0, data: { output: "x".repeat(1_000_000) } };
  eventListener(session, giant);
  eventListener(session, { type: "assistant/chunk", seq: 2, time: 0, data: { chunk: { type: "text-delta", text: "after the giant" } } });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && sent.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  connections.dispose(agent.session.id);

  assert.ok(sent.length >= 1, "the events were never delivered");
  const firstBatch = JSON.parse(sent[0]).events;
  const giantRecord = firstBatch.find((item) => item.event?.data?.output);
  assert.ok(giantRecord, "the giant event still arrives, in shrunken form");
  assert.ok(giantRecord.event.data.output.length < 5_000, `expected the giant string clipped, saw ${giantRecord.event.data.output.length} chars`);
  assert.ok(JSON.parse(sent[sent.length - 1]).events.some((item) => item.event?.data?.chunk?.text === "after the giant"), "the event after the giant still arrives in order");
  for (const body of sent) {
    assert.ok(body.length <= 448 * 1024 + 64, `a batch overran the bridge's limit: ${body.length}`);
  }
});

// A question card whose POST fails once used to be dropped forever: the desktop
// kept showing it, the phone showed nothing and could not select. It must be kept in
// a queue that survives even a reconnect, and delivered when the channel comes back.
test("a question card that fails to post is retried instead of dropped", async (t) => {
  let interactionsPosts = 0;
  const delivered = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/register")) {
      return Response.json({ channel: { pollPath: "/poll", eventsPath: "/events", interactionsPath: "/interactions", resultsPath: "/results", token: "test-token" }, pairing: { url: "x" }, project: { cwd: "D:\\work" } });
    }
    if (target.includes("/interactions")) {
      interactionsPosts += 1;
      if (interactionsPosts === 1) return Response.json({ error: "network blip" }, { status: 503 });
      delivered.push(JSON.parse(options.body).interactions[0]);
      return Response.json({ accepted: true });
    }
    return Response.json({ commands: [] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const connections = new PhoneConnections({
    on() {},
    commands: { register() {} },
    apiProxy: {
      sessions: { async models({ rpcId }) { return { rpcId, result: { ok: true, value: { current: { provider: "ds", model: "ds-chat" }, routable: true, groups: [], failures: [] } } }; } },
      events: {
        mux: async function* () {
          yield { rpcId: "rpc-question-1", payload: {
            sessionId: "dsh-question-card",
            type: "question/requested",
            questions: [{ id: "q1", question: "要继续吗？", options: [{ label: "继续" }, { label: "停止" }] }],
          } };
        },
      },
    },
    logger: { warn() {} },
  });

  const agent = { session: { id: "dsh-question-card", header: { cwd: "D:\\work", title: "提问" } }, options: { provider: "ds", model: "ds-chat" } };
  await connections.connect(agent);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && delivered.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  connections.dispose(agent.session.id);

  assert.equal(delivered.length, 1, `expected the card to be delivered after its retry, saw ${delivered.length}`);
  assert.equal(delivered[0].kind, "question-requested");
  assert.equal(delivered[0].questions.length, 1);
  assert.equal(interactionsPosts, 2, "the first attempt failed and the second succeeded");
});