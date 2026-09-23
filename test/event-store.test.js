import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";

test("event store persists monotonic sequence and resumes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.jsonl");
  const first = new EventStore({ filePath });
  await first.init();
  await first.append("one", { value: 1 }, { sessionId: "s1" });
  await first.append("two", { value: 2 }, { sessionId: "s2" });
  assert.deepEqual(first.listAfter(1).map((event) => event.kind), ["two"]);
  assert.deepEqual(first.listAfter(0, { sessionId: "s1" }).map((event) => event.kind), ["one"]);

  const restored = new EventStore({ filePath });
  await restored.init();
  const event = await restored.append("three", {});
  assert.equal(event.seq, 3);
});
test("event store recovers its append queue after a transient write failure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-events-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.jsonl");
  let attempts = 0;
  const store = new EventStore({
    filePath,
    appendFileImpl: async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary write failure");
      return appendFile(...args);
    },
  });
  await store.init();

  await assert.rejects(store.append("first", {}), /event log is temporarily unavailable/);
  const second = await store.append("second", {});

  assert.equal(second.seq, 2);
  assert.deepEqual(store.listAfter(0).map((event) => event.kind), ["second"]);
  const persisted = (await readFile(filePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(persisted.map((event) => event.kind), ["second"]);
});

// The mobile symptom: a phone opening a conversation received almost none of its
// replies, because one turn's token deltas filled the whole replay window. The
// window must hold real conversation, not tokens.
test("a flood of streamed deltas never evicts committed messages from the replay window", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-events-deltas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EventStore({ filePath: path.join(directory, "events.jsonl"), maxMemory: 500 });
  await store.init();

  const replies = [];
  for (let turn = 1; turn <= 8; turn += 1) {
    await store.append("turn.started", {}, { sessionId: "s1", turnId: `p:${turn}` });
    let text = "";
    for (let index = 1; index <= 900; index += 1) {
      const piece = `w${index} `;
      const offset = text.length;
      text += piece;
      await store.append("message.delta", { role: "assistant", text: piece, offset }, { sessionId: "s1", turnId: `p:${turn}` });
    }
    replies.push(text);
    await store.append("message.completed", { role: "assistant", text }, { sessionId: "s1", turnId: `p:${turn}` });
    await store.append("turn.completed", { status: "completed" }, { sessionId: "s1", turnId: `p:${turn}` });
  }

  const retained = store.listAfter(0, { sessionId: "s1" });
  const committed = retained.filter((event) => event.kind === "message.completed").map((event) => event.payload.text);
  assert.deepEqual(committed, replies, "streamed deltas evicted committed replies from the replay window");

  // Exactly one retained delta per turn, merged so a reconnecting phone still
  // receives the whole in-progress text.
  const deltas = retained.filter((event) => event.kind === "message.delta");
  assert.equal(deltas.length, 8);
  for (const delta of deltas) assert.equal(delta.payload.offset, 0);
  assert.equal(deltas.at(-1).payload.text, replies.at(-1));
  assert.ok(retained.length < 60, `replay window holds ${retained.length} events; tokens are still occupying it`);
});

test("a restart compacts an on-disk delta flood instead of replaying it raw", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-events-compact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.jsonl");
  const store = new EventStore({ filePath, maxMemory: 200 });
  await store.init();
  await store.append("message.completed", { role: "assistant", text: "answer one" }, { sessionId: "s1", turnId: "p:1" });
  await store.append("message.completed", { role: "assistant", text: "answer two" }, { sessionId: "s1", turnId: "p:2" });
  let streamed = "";
  for (let index = 1; index <= 400; index += 1) {
    const piece = `t${index} `;
    await store.append("message.delta", { role: "assistant", text: piece, offset: streamed.length }, { sessionId: "s1", turnId: "p:3" });
    streamed += piece;
  }
  await store.append("message.completed", { role: "assistant", text: "answer three" }, { sessionId: "s1", turnId: "p:3" });

  // The log must store each chunk once, not a growing merged prefix per line.
  const lines = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
  const persistedDeltaBytes = lines
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "message.delta")
    .reduce((total, event) => total + event.payload.text.length, 0);
  assert.equal(persistedDeltaBytes, streamed.length, "the log stored merged prefixes instead of the original chunks");

  const restored = new EventStore({ filePath, maxMemory: 200 });
  await restored.init();
  const retained = restored.listAfter(0, { sessionId: "s1" });
  const committed = retained.filter((event) => event.kind === "message.completed").map((event) => event.payload.text);
  assert.deepEqual(committed, ["answer one", "answer two", "answer three"]);
  assert.equal(retained.filter((event) => event.kind === "message.delta").length, 1);
  assert.equal(retained.find((event) => event.kind === "message.delta").payload.text, streamed);
});
