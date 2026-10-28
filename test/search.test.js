import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";

async function store(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl"), ...options });
  await eventStore.init();
  return { directory, eventStore };
}

test("search finds message text, ignores short queries and ranks newest first", async (t) => {
  const { eventStore } = await store(t);
  await eventStore.append("message.completed", { role: "user", text: "先把登录接口改成 JWT" }, { sessionId: "s1" });
  await eventStore.append("message.completed", { role: "assistant", text: "登录接口已经改完，JWT 过期时间 2 小时" }, { sessionId: "s1" });
  await eventStore.append("message.completed", { role: "user", text: "顺便看看支付" }, { sessionId: "s2" });

  const hits = await eventStore.search("jwt");
  assert.equal(hits.hits.length, 2);
  assert.ok(hits.hits[0].seq > hits.hits[1].seq, "the newest hit has to come first");
  assert.match(hits.hits[0].snippet, /JWT/);
  assert.equal(hits.hits[0].sessionId, "s1");

  const tooShort = await eventStore.search("j");
  assert.equal(tooShort.hits.length, 0, "one character is not a search");
  assert.equal((await eventStore.search("")).hits.length, 0);
});

test("search covers tool commands and keeps one session from flooding the list", async (t) => {
  const { eventStore } = await store(t);
  for (let index = 0; index < 12; index += 1) {
    await eventStore.append("message.completed", { role: "assistant", text: `migration step ${index} ok` }, { sessionId: "one" });
  }
  await eventStore.append("tool.started", { command: "npm run migration", type: "shell" }, { sessionId: "two" });
  await eventStore.append("message.completed", { role: "user", text: "迁移脚本还有问题" }, { sessionId: "two" });

  const hits = await eventStore.search("migration", { limit: 10, perSession: 3 });
  const perSession = new Map();
  for (const hit of hits.hits) perSession.set(hit.sessionId, (perSession.get(hit.sessionId) ?? 0) + 1);
  assert.ok((perSession.get("one") ?? 0) <= 3, `one session contributed ${perSession.get("one")} hits`);
  assert.ok(hits.hits.some((hit) => hit.sessionId === "two"));
  assert.ok(hits.hits.some((hit) => hit.kind === "tool.started"), "tool commands are searchable too");
});

test("search still works after the memory window has evicted the events", async (t) => {
  const { eventStore } = await store(t, { maxMemory: 5 });
  await eventStore.append("message.completed", { role: "user", text: "第一次要改网关的超时" }, { sessionId: "s1" });
  for (let index = 0; index < 30; index += 1) {
    await eventStore.append("message.completed", { role: "assistant", text: `填充 ${index}` }, { sessionId: "s1" });
  }
  const hits = await eventStore.search("网关");
  assert.equal(hits.hits.length, 1, "an evicted message has to come back from the log");
  assert.equal(hits.hits[0].source, "log");
});