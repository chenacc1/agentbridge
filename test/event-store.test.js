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
