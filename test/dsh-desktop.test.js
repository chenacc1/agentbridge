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
