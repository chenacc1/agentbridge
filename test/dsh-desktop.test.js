import test from "node:test";
import assert from "node:assert/strict";
import { DshDesktopChannelManager } from "../src/dsh-desktop-channels.js";
import { DshDesktopAdapter } from "../src/adapters/dsh-desktop.js";

function registration(channels) {
  return channels.register({
    providerSessionId: "dsh-session-123",
    cwd: "D:\\work",
    title: "DSH test",
    provider: "deepseek",
    model: "deepseek-chat",
    modelDirectory: {
      current: { provider: "deepseek", model: "deepseek-chat" },
      routable: true,
      groups: [{
        id: "deepseek",
        name: "DeepSeek",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "high", name: "High" }] } }],
      }],
      failures: [],
    },
  });
}

test("DSH Desktop declares an attach-only conversation interface", async () => {
  const adapter = new DshDesktopAdapter({ channels: new DshDesktopChannelManager() });

  assert.equal(adapter.capabilities.create, false);
  assert.equal(adapter.capabilities.attach, true);
  assert.equal(adapter.capabilities.discover, false);
});

test("DSH Desktop channel authenticates, queues phone commands, and rotates credentials", async () => {
  const channels = new DshDesktopChannelManager();
  const first = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const events = [];
  const handle = await adapter.attach({ emit: async (...args) => events.push(args) }, first.providerSessionId);

  await adapter.send(handle, { text: "hello from phone", commandId: "phone-command-1" });
  assert.throws(() => channels.poll(first.id, "wrong-token", 0), /Invalid DSH Desktop channel/);
  const firstPoll = channels.poll(first.id, first.token, 0);
  assert.deepEqual(firstPoll.commands.map(({ kind, text }) => ({ kind, text })), [
    { kind: "message", text: "hello from phone" },
  ]);
  assert.equal(channels.poll(first.id, first.token, firstPoll.commands[0].seq).commands.length, 0);

  const second = registration(channels);
  assert.throws(() => channels.poll(first.id, first.token, 0), /Invalid DSH Desktop channel/);
  assert.equal(channels.poll(second.id, second.token, 0).commands.length, 0);
});

test("DSH Desktop durable events map to the mobile conversation once", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const emitted = [];
  await adapter.attach({ emit: async (kind, payload, extra) => emitted.push({ kind, payload, extra }) }, channel.providerSessionId);

  const response = await channels.ingest(channel.id, channel.token, [
    { event: { type: "turn/start", seq: 1, time: 1, data: { turn: 7 } }, origin: "desktop" },
    {
      event: { type: "user/message", seq: 2, time: 2, data: { id: "phone-message", content: [{ type: "text", text: "hello" }] } },
      origin: "phone",
    },
    {
      event: { type: "assistant/chunk", seq: 3, time: 3, data: { turn: 7, step: 1, chunk: { type: "text-delta", index: 0, text: "Hi" } } },
      origin: "desktop",
    },
    {
      event: { type: "assistant/message", seq: 4, time: 4, data: { turn: 7, step: 1, message: { content: [{ type: "text", text: "Hi there" }], source: { kind: "model", provider: "deepseek", model: "deepseek-chat" } } } },
      origin: "desktop",
    },
    {
      event: { type: "turn/end", seq: 5, time: 5, data: { turn: 7, reason: { kind: "completed" } } },
      origin: "desktop",
    },
  ]);

  assert.equal(response.accepted, 5);
  assert.deepEqual(emitted.map((event) => event.kind), [
    "turn.started",
    "message.delta",
    "message.completed",
    "turn.completed",
  ]);
  assert.equal(emitted[1].extra.turnId, "dsh-session-123:7");
  assert.equal(emitted[2].payload.text, "Hi there");
  const replay = await channels.ingest(channel.id, channel.token, [
    { event: { type: "turn/end", seq: 5, time: 5, data: { turn: 7, reason: { kind: "completed" } } } },
  ]);
  assert.equal(replay.accepted, 0);
});

test("DSH Desktop model selection waits for a real companion confirmation", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const handle = await adapter.attach({ emit: async () => {} }, channel.providerSessionId);

  const pending = adapter.selectModel(handle, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" });
  const command = channels.poll(channel.id, channel.token, 0).commands[0];
  assert.equal(command.kind, "select-model");
  assert.equal(command.selection.reasoningEffort, "high");
  assert.deepEqual(channels.complete(channel.id, channel.token, command.requestId, {
    ok: true,
    selected: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
  }), { accepted: true });
  assert.deepEqual(await pending, { selected: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" } });
  assert.equal(adapter.modelDirectory(handle).current.reasoningEffort, "high");
  await assert.rejects(adapter.selectModel(handle, { provider: "deepseek", model: "not-configured" }), /not in the current DSH Desktop model directory/);
});

test("DSH Desktop keeps a host model catalog when the current UI model is unavailable", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = channels.register({
    providerSessionId: "dsh-live-ui-session",
    cwd: "D:\\work",
    title: "DSH live UI",
    modelDirectory: {
      current: null,
      routable: false,
      groups: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }] }],
      failures: [{ id: "dsh-session-models", name: "DSH Desktop", message: "session lookup missed; using host catalog" }],
    },
  });
  const adapter = new DshDesktopAdapter({ channels });
  const handle = await adapter.attach({ emit: async () => {} }, channel.providerSessionId);

  assert.equal(adapter.modelDirectory(handle).current, null);
  assert.equal(adapter.modelDirectory(handle).groups[0].models[0].id, "deepseek-v4-pro");
  assert.match(adapter.modelDirectory(handle).failures[0].message, /host catalog/);

  const pending = adapter.selectModel(handle, { provider: "deepseek-official", model: "deepseek-v4-pro" });
  const command = channels.poll(channel.id, channel.token, 0).commands[0];
  channels.complete(channel.id, channel.token, command.requestId, {
    ok: true,
    selected: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  });
  assert.deepEqual(await pending, { selected: { provider: "deepseek-official", model: "deepseek-v4-pro" } });
});

// The desktop companion can have several flushes in flight while a turn streams.
// Overlapping batches used to interleave, which reordered a turn's streamed text
// and let one batch's high-water mark discard another batch's events entirely.
test("concurrent DSH Desktop batches keep every event and preserve their order", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const applied = [];
  await adapter.attach({
    emit: async (kind, payload, extra) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      applied.push({ kind, text: payload?.text, turnId: extra?.turnId });
    },
  }, channel.providerSessionId);

  const batch = (from, to) => {
    const events = [];
    for (let seq = from; seq <= to; seq += 1) {
      events.push({
        event: {
          type: "assistant/chunk",
          seq,
          time: seq,
          data: { turn: 7, step: 1, chunk: { type: "text-delta", index: 0, text: `w${seq} ` } },
        },
        origin: "desktop",
      });
    }
    return { events };
  };

  const batches = [batch(1, 60), batch(61, 120), batch(121, 180), batch(181, 240)];
  const responses = await Promise.all(batches.map(({ events }) => channels.ingest(channel.id, channel.token, events)));

  assert.deepEqual(responses.map((response) => response.accepted), [60, 60, 60, 60]);
  assert.equal(applied.length, 240, "some events were dropped by a concurrent batch");
  assert.deepEqual(
    applied.map((event) => event.text.trim()),
    Array.from({ length: 240 }, (_value, index) => `w${index + 1}`),
    "streamed text arrived out of order",
  );
  assert.equal(new Set(applied.map((event) => event.turnId)).size, 1);
});

test("a batch that arrives after a newer one is still accepted exactly once", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const applied = [];
  await adapter.attach({
    emit: async (kind, payload) => applied.push({ kind, text: payload?.text }),
  }, channel.providerSessionId);

  const records = (from, to) => Array.from({ length: to - from + 1 }, (_value, index) => ({
    event: {
      type: "assistant/chunk",
      seq: from + index,
      time: from + index,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: `w${from + index} ` } },
    },
    origin: "desktop",
  }));

  // A retried older batch arrives after a newer one has already been applied.
  await channels.ingest(channel.id, channel.token, records(11, 20));
  const retried = await channels.ingest(channel.id, channel.token, records(1, 10));
  assert.equal(retried.accepted, 10, "a late batch was discarded by the high-water mark");

  const replayed = await channels.ingest(channel.id, channel.token, records(1, 20));
  assert.equal(replayed.accepted, 0, "replaying an applied batch must be a no-op");

  // Acceptance is what matters here: the companion holds newer batches back
  // until a failed one has been retried, so no event may be lost or doubled.
  const texts = applied.map((event) => event.text.trim());
  assert.equal(texts.length, 20);
  assert.deepEqual([...texts].sort(), Array.from({ length: 20 }, (_value, index) => `w${index + 1}`).sort());
  assert.equal(new Set(texts).size, 20, "an event was applied twice");
});

// A question or an approval blocks the turn until a human answers. Before this
// seam existed the phone showed nothing at all and the run simply stopped.
test("DSH Desktop forwards a question to the phone and returns the chosen answers", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const emitted = [];
  const handle = await adapter.attach({
    emit: async (kind, payload, extra) => emitted.push({ kind, payload, extra }),
  }, channel.providerSessionId);

  const handled = await channels.ingestInteractions(channel.id, channel.token, [{
    kind: "question-requested",
    requestId: "dsh-rpc-question-1",
    questions: [{
      id: "mode",
      header: "Choose Mode",
      question: "Which storage should I use?",
      options: [{ label: "SQLite", description: "single file" }, { label: "Postgres" }],
      multiSelect: false,
    }],
  }]);

  assert.equal(handled.handled, 1);
  const requested = emitted.find((event) => event.kind === "input.requested");
  assert.ok(requested, "the phone was never told about the question");
  assert.equal(requested.payload.questions[0].question, "Which storage should I use?");
  assert.deepEqual(requested.payload.questions[0].options.map((option) => option.label), ["SQLite", "Postgres"]);

  const answering = adapter.resolveInput(handle, requested.payload.requestId, {
    answers: [{ id: "mode", selected: ["SQLite"] }],
  });
  const command = channels.poll(channel.id, channel.token, 0).commands.at(-1);
  assert.equal(command.kind, "answer-question");
  assert.equal(command.rpcId, "dsh-rpc-question-1");
  assert.deepEqual(command.answers, [{ id: "mode", selected: ["SQLite"] }]);
  channels.complete(channel.id, channel.token, command.requestId, { ok: true });
  assert.equal(await answering, true);

  await assert.rejects(
    adapter.resolveInput(handle, requested.payload.requestId, { answers: [] }),
    /missing or already answered/,
  );
});

test("DSH Desktop skips a question and reports the approval decision as an outcome", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const emitted = [];
  const handle = await adapter.attach({
    emit: async (kind, payload) => emitted.push({ kind, payload }),
  }, channel.providerSessionId);

  await channels.ingestInteractions(channel.id, channel.token, [{
    kind: "approval-requested",
    requestId: "dsh-rpc-approval-1",
    dshApprovalId: "dsh-approval-1",
    toolName: "bash",
    reason: "network access",
  }]);
  const approval = emitted.find((event) => event.kind === "approval.requested");
  assert.ok(approval, "the phone was never told about the approval prompt");
  assert.equal(approval.payload.method, "bash");
  assert.equal(approval.payload.request.reason, "network access");

  const deciding = adapter.resolveApproval(handle, approval.payload.approvalId, "deny");
  const command = channels.poll(channel.id, channel.token, 0).commands.at(-1);
  assert.equal(command.kind, "answer-approval");
  assert.equal(command.dshApprovalId, "dsh-approval-1");
  assert.equal(command.outcome, "rejected");
  channels.complete(channel.id, channel.token, command.requestId, { ok: true });
  assert.equal(await deciding, true);

  await channels.ingestInteractions(channel.id, channel.token, [{
    kind: "question-requested",
    requestId: "dsh-rpc-question-2",
    questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "yes" }] }],
  }]);
  const question = emitted.filter((event) => event.kind === "input.requested").at(-1);
  const cancelling = adapter.resolveInput(handle, question.payload.requestId, { answers: [], cancel: true });
  const cancelCommand = channels.poll(channel.id, channel.token, 0).commands.at(-1);
  assert.equal(cancelCommand.kind, "cancel-question");
  channels.complete(channel.id, channel.token, cancelCommand.requestId, { ok: true });
  assert.equal(await cancelling, true);
});

test("a question answered in the desktop window retires the phone's card", async () => {
  const channels = new DshDesktopChannelManager();
  const channel = registration(channels);
  const adapter = new DshDesktopAdapter({ channels });
  const emitted = [];
  const handle = await adapter.attach({
    emit: async (kind, payload) => emitted.push({ kind, payload }),
  }, channel.providerSessionId);

  await channels.ingestInteractions(channel.id, channel.token, [{
    kind: "question-requested",
    requestId: "dsh-rpc-question-3",
    questions: [{ id: "confirm", question: "Proceed?" }],
  }]);
  const requested = emitted.find((event) => event.kind === "input.requested");

  await channels.ingestInteractions(channel.id, channel.token, [{
    kind: "question-resolved",
    requestId: "dsh-rpc-question-3",
    outcome: "answered",
  }]);
  const resolved = emitted.find((event) => event.kind === "input.resolved");
  assert.deepEqual(resolved.payload, { requestId: requested.payload.requestId, outcome: "desktop" });
  await assert.rejects(
    adapter.resolveInput(handle, requested.payload.requestId, { answers: [] }),
    /missing or already answered/,
  );
});

