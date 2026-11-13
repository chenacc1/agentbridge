import test from "node:test";
import assert from "node:assert/strict";
import { buildEntries, absorbEvent } from "../public/transcript.js";

// The phone is read at a glance, on a narrow screen. Intermediate work says what is
// happening; only the final answer is spelled out. These tests pin that contract so a
// later "show everything" tweak cannot quietly turn the transcript back into a wall.

function message({ seq, turnId, role = "assistant", text, eventId }) {
  return {
    v: 1,
    eventId: eventId ?? `m${seq}`,
    seq,
    time: new Date(1700000000000 + seq).toISOString(),
    sessionId: "s1",
    turnId,
    kind: "message.completed",
    payload: { role, text },
  };
}

function tool({ seq, turnId, type = "Bash", command }) {
  return {
    eventId: `t${seq}`,
    seq,
    time: new Date(1700000000000 + seq).toISOString(),
    sessionId: "s1",
    turnId,
    kind: "tool.started",
    payload: { type, command },
  };
}

function buffer() {
  const events = [];
  const deltaIndex = new Map();
  return { events, add: (event) => absorbEvent(events, deltaIndex, event) };
}

test("tool activity is one line naming the tool, with the raw material behind a disclosure", () => {
  const store = buffer();
  store.add(message({ seq: 1, turnId: "p:1", role: "user", text: "看下端口占用" }));
  store.add(tool({ seq: 2, turnId: "p:1", type: "Bash", command: "netstat -ano | findstr 8787" }));

  const entries = buildEntries(store.events);
  const rendered = entries.at(-1).html;
  assert.match(rendered, /调用 Bash/);
  assert.match(rendered, /<details class="tool-output"><summary>详情<\/summary>/);
  const summary = rendered.split("<details")[0];
  // The program name is enough to say "what is happening"; the arguments stay inside.
  assert.match(summary, /netstat/);
  assert.doesNotMatch(summary, /-ano|\| findstr 8787/, "the one-line summary must not carry the raw command");
});

test("an intermediate assistant message collapses; only the final answer opens in full", () => {
  const store = buffer();
  store.add(message({ seq: 1, turnId: "p:1", role: "user", text: "重构一下" }));
  store.add(message({ seq: 2, turnId: "p:1", text: "第一步：先读文件确认结构" }));
  store.add(message({ seq: 3, turnId: "p:1", text: "第二步：再改入口" }));
  store.add(message({ seq: 4, turnId: "p:1", text: "改完了：入口文件现在只负责装配。" }));

  const entries = buildEntries(store.events);
  assert.equal(entries.length, 4);
  assert.match(entries[1].html, /中间过程/);
  assert.match(entries[1].html, /<details class="step-detail">/);
  assert.match(entries[2].html, /中间过程/);
  assert.match(entries[3].html, /改完了/);
  assert.doesNotMatch(entries[3].html, /step-detail/, "the answer itself is not behind a disclosure");
});

test("a reply that arrives as a stream stays collapsed while it is arriving", () => {
  const store = buffer();
  store.add({
    eventId: "d1",
    seq: 1,
    time: new Date(1700000000000).toISOString(),
    sessionId: "s1",
    turnId: "p:1",
    kind: "message.delta",
    payload: { role: "assistant", text: "正在思考第一步……" },
  });

  const rendered = buildEntries(store.events).at(-1).html;
  assert.match(rendered, /正在生成回答/);
  assert.match(rendered, /<details/);
  assert.doesNotMatch(rendered.split("<details")[0], /正在思考第一步/, "live text waits behind the disclosure");
});

test("a message that carries an attachment is always rendered in full", () => {
  const store = buffer();
  store.add(message({ seq: 1, turnId: "p:1", role: "user", text: "截个图" }));
  store.add({
    ...message({ seq: 2, turnId: "p:1", text: "" }),
    payload: { role: "assistant", text: "", attachments: [{ id: "a1", name: "shot.png", kind: "image", url: "/api/attachments/a1" }] },
  });
  store.add(message({ seq: 3, turnId: "p:1", text: "截图在这里" }));

  const entries = buildEntries(store.events);
  const carried = entries.find((entry) => entry.html.includes("shot.png"));
  assert.ok(carried, "the attachment row exists");
  assert.doesNotMatch(carried.html, /step-detail/);
});
