import test from "node:test";
import assert from "node:assert/strict";
import { absorbEvent, buildEntries, indexDeltas, trimEvents } from "../public/transcript.js";

// These tests guard the mobile symptom this module was extracted for: a long
// streamed conversation used to reach the phone with most of its replies
// missing, because token deltas filled the buffer and evicted the messages.

function completedMessage({ seq, sessionId = "s1", turnId, role = "assistant", text, eventId }) {
  return {
    v: 1,
    eventId: eventId ?? `m${seq}`,
    seq,
    time: new Date(1700000000000 + seq).toISOString(),
    sessionId,
    turnId,
    kind: "message.completed",
    payload: { role, text },
  };
}

function delta({ seq, sessionId = "s1", turnId, text, offset, eventId }) {
  return {
    v: 1,
    eventId: eventId ?? `d${seq}`,
    seq,
    time: new Date(1700000000000 + seq).toISOString(),
    sessionId,
    turnId,
    kind: "message.delta",
    payload: { role: "assistant", text, ...(offset === undefined ? {} : { offset }) },
  };
}

function buffer() {
  const events = [];
  const deltaIndex = new Map();
  return { events, deltaIndex, add: (event) => absorbEvent(events, deltaIndex, event) };
}

test("a long turn's deltas never evict the conversation it belongs to", () => {
  const store = buffer();
  const replies = [];
  let seq = 0;

  // Six turns, each streaming thousands of token deltas and committing two
  // step messages: the shape captured from production (1943 deltas in one turn).
  for (let turn = 1; turn <= 6; turn += 1) {
    for (let step = 1; step <= 2; step += 1) {
      let text = "";
      for (let index = 1; index <= 1500; index += 1) {
        seq += 1;
        const piece = `t${turn}s${step}w${index} `;
        text += piece;
        store.add(delta({ seq, turnId: `p:${turn}`, text: piece, offset: text.length - piece.length }));
      }
      seq += 1;
      replies.push(text);
      store.add(completedMessage({ seq, turnId: `p:${turn}`, text }));
    }
  }

  // The buffer only holds a bounded number of events, but the token chatter must
  // not have pushed any committed reply out of it.
  const retained = new Set(store.events.filter((event) => event.kind === "message.completed").map((event) => event.payload.text));
  const lost = replies.filter((text) => !retained.has(text));
  assert.deepEqual(lost, [], `${lost.length} of ${replies.length} replies were evicted by streamed deltas`);

  // One delta entry per turn, not one per token.
  assert.equal(store.events.filter((event) => event.kind === "message.delta").length, 6);
});

test("every committed reply is rendered completely, in order", () => {
  const store = buffer();
  const replies = [];
  let seq = 0;
  for (let turn = 1; turn <= 4; turn += 1) {
    seq += 1;
    store.add(completedMessage({ seq, turnId: `p:${turn}`, role: "user", text: `ask ${turn}` }));
    for (let index = 1; index <= 400; index += 1) {
      seq += 1;
      store.add(delta({ seq, turnId: `p:${turn}`, text: `w${index} `, offset: (index - 1) * 6 }));
    }
    seq += 1;
    const text = Array.from({ length: 400 }, (_value, index) => `w${index + 1} `).join("");
    replies.push(text);
    store.add(completedMessage({ seq, turnId: `p:${turn}`, text }));
  }

  const entries = buildEntries(store.events);
  const html = entries.map((entry) => entry.html).join("");
  for (const reply of replies) {
    assert.ok(html.includes(reply.trim().slice(0, 40)), "a committed reply is missing from the transcript");
    assert.ok(html.includes(reply.trim().slice(-40)), "a committed reply is truncated in the transcript");
  }
  assert.equal(entries.filter((entry) => entry.html.includes(">你<")).length, 4);
  assert.equal(entries.filter((entry) => entry.html.includes(">Agent<")).length, 4);
});

test("an in-progress reply renders its full streamed text", () => {
  const store = buffer();
  let seq = 0;
  let text = "";
  for (let index = 1; index <= 500; index += 1) {
    seq += 1;
    const piece = `chunk${index} `;
    store.add(delta({ seq, turnId: "p:9", text: piece, offset: text.length }));
    text += piece;
  }

  const entries = buildEntries(store.events);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].html.includes("Agent 正在回复"));
  assert.ok(entries[0].html.includes(text.trim()), "the streamed reply is not fully rendered");
});

test("a merged or replayed chunk rewrites its offset instead of duplicating text", () => {
  const store = buffer();
  // Live chunks, then the bridge's merged snapshot of the same turn.
  store.add(delta({ seq: 1, turnId: "p:1", text: "abc", offset: 0 }));
  store.add(delta({ seq: 2, turnId: "p:1", text: "def", offset: 3 }));
  const merged = buildEntries(store.events);
  assert.ok(merged[0].html.includes("abcdef"));

  store.add(delta({ seq: 3, turnId: "p:1", text: "abcdef", offset: 0 }));
  const afterSnapshot = buildEntries(store.events);
  assert.equal(afterSnapshot.length, 1);
  assert.ok(afterSnapshot[0].html.includes("abcdef"));
  assert.ok(!afterSnapshot[0].html.includes("abcabcdef"), "a replayed snapshot duplicated the streamed text");
});

test("deltas are ignored once the turn's committed message arrives", () => {
  const store = buffer();
  store.add(delta({ seq: 1, turnId: "p:1", text: "draft", offset: 0 }));
  store.add(completedMessage({ seq: 2, turnId: "p:1", text: "final answer" }));
  const entries = buildEntries(store.events);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].html.includes("final answer"));
  assert.ok(!entries[0].html.includes("draft"));
});

test("trimming history keeps the freshest conversation and reindexes deltas", () => {
  const store = buffer();
  for (let index = 0; index < 30; index += 1) {
    store.add(completedMessage({ seq: index + 1, turnId: `p:${index}`, text: `reply ${index}` }));
  }
  store.add(delta({ seq: 100, turnId: "p:99", text: "live", offset: 0 }));
  const trimmed = trimEvents(store.events, store.deltaIndex, { maxEvents: 10, trimChunk: 5 });
  assert.equal(trimmed, true);
  assert.ok(store.events.length <= 10);
  assert.equal(store.deltaIndex.size, 1, "the delta index was not rebuilt after trimming");
  const entries = buildEntries(store.events);
  assert.ok(entries.some((entry) => entry.html.includes("live")));
  assert.ok(entries.some((entry) => entry.html.includes("reply 29")));
});

test("indexDeltas rebuilds an index over an existing buffer", () => {
  const store = buffer();
  store.add(delta({ seq: 1, turnId: "p:1", text: "x", offset: 0 }));
  const rebuilt = indexDeltas(store.events, new Map());
  assert.equal(rebuilt.size, 1);
  const events = store.events;
  const deltaIndex = new Map();
  indexDeltas(events, deltaIndex);
  absorbEvent(events, deltaIndex, delta({ seq: 2, turnId: "p:1", text: "y", offset: 1 }));
  assert.equal(events.filter((event) => event.kind === "message.delta").length, 1);
  assert.ok(buildEntries(events)[0].html.includes("xy"));
});

test("agent output is escaped and never injectable", () => {
  const store = buffer();
  store.add(completedMessage({ seq: 1, turnId: "p:1", text: "<img src=x onerror=alert(1)>" }));
  const html = buildEntries(store.events)[0].html;
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});
