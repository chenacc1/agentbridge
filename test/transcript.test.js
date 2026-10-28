import test from "node:test";
import assert from "node:assert/strict";
import { absorbEvent, buildEntries, indexDeltas, mergeHistory, trimEvents } from "../public/transcript.js";

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

// A question card is the only transcript entry the phone can act on besides an
// approval, so it must carry usable inputs and escape agent-supplied text.
test("a pending question renders selectable options and free text", () => {
  const store = buffer();
  store.add({
    v: 1,
    eventId: "q1",
    seq: 1,
    time: new Date(1700000000000).toISOString(),
    sessionId: "s1",
    turnId: "p:1",
    kind: "input.requested",
    payload: {
      requestId: "req-1",
      questions: [
        {
          id: "mode",
          header: "Choose Mode",
          question: "Which storage? <script>alert(1)</script>",
          options: [{ label: "SQLite", description: "single file" }, { label: "Postgres" }],
        },
        { id: "extra", question: "Anything else?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] },
      ],
    },
  });
  const entries = buildEntries(store.events);
  assert.equal(entries.length, 1);
  const html = entries[0].html;
  assert.ok(html.includes("data-input-submit=\"req-1\""));
  assert.ok(html.includes("data-input-cancel=\"req-1\""));
  assert.ok(html.includes("data-input-question=\"mode\""));
  assert.ok(html.includes("type=\"radio\""));
  assert.ok(html.includes("type=\"checkbox\""), "a multi-select question must render checkboxes");
  assert.ok(html.includes("data-input-multi=\"1\""));
  assert.ok(html.includes("data-input-custom"));
  assert.ok(!html.includes("<script"), "agent-supplied question text was injected as HTML");
});

test("a question resolved elsewhere stops looking answerable", () => {
  const store = buffer();
  store.add({
    v: 1,
    eventId: "r1",
    seq: 1,
    time: new Date(1700000000000).toISOString(),
    sessionId: "s1",
    turnId: "p:1",
    kind: "input.resolved",
    payload: { requestId: "req-1", outcome: "desktop" },
  });
  store.add({
    v: 1,
    eventId: "r2",
    seq: 2,
    time: new Date(1700000000000).toISOString(),
    sessionId: "s1",
    turnId: "p:1",
    kind: "approval.resolved",
    payload: { approvalId: "appr-1", decision: "deny" },
  });
  const entries = buildEntries(store.events);
  assert.ok(entries[0].html.includes("已在电脑上回答"));
  assert.ok(entries[1].html.includes("已拒绝"));
});

// Switching conversations must load that conversation's history on demand and
// must not strike out entries the live stream already delivered.
test("history merges into the live buffer once, in sequence order", () => {
  const store = buffer();
  store.add(completedMessage({ seq: 10, sessionId: "s2", turnId: "p:1", text: "live newest" }));

  const added = mergeHistory(store.events, store.deltaIndex, [
    { ...completedMessage({ seq: 1, sessionId: "s2", turnId: "p:1", text: "oldest" }), eventId: "h1" },
    { ...completedMessage({ seq: 5, sessionId: "s2", turnId: "p:1", text: "middle" }), eventId: "h2" },
    { ...completedMessage({ seq: 10, sessionId: "s2", turnId: "p:1", text: "live newest" }) },
  ]);
  assert.equal(added, 2, "an event already in the buffer was inserted again");
  assert.deepEqual(store.events.map((event) => event.seq), [1, 5, 10]);

  const entries = buildEntries(store.events.filter((event) => event.sessionId === "s2"));
  assert.deepEqual(entries.map((entry) => entry.html.match(/oldest|middle|live newest/)?.[0]).filter(Boolean), ["oldest", "middle", "live newest"]);

  // A second load of the same page adds nothing.
  assert.equal(mergeHistory(store.events, store.deltaIndex, [
    { ...completedMessage({ seq: 1, sessionId: "s2", turnId: "p:1", text: "oldest" }), eventId: "h1" },
  ]), 0);
});


// A freshly loaded history page is the oldest data in the buffer, so plain
// oldest-first trimming would delete it moments later if another conversation
// is still streaming.
test("trimming protects the conversation the reader is looking at", () => {
  const store = buffer();
  for (let index = 0; index < 20; index += 1) {
    store.add(completedMessage({ seq: index + 1, sessionId: "busy", turnId: `p:${index}`, text: `busy ${index}` }));
  }
  // History fetched for the quiet conversation is older than everything above.
  for (let index = 0; index < 6; index += 1) {
    store.add(completedMessage({ seq: 100 + index, sessionId: "quiet", turnId: "p:1", text: `quiet ${index}` }));
  }

  assert.equal(trimEvents(store.events, store.deltaIndex, { maxEvents: 12, trimChunk: 0, keepSessionId: "quiet" }), true);
  const kept = store.events.filter((event) => event.sessionId === "quiet");
  assert.equal(kept.length, 6, "the conversation being read was trimmed away");
  assert.ok(store.events.length <= 12);
  assert.ok(store.events.filter((event) => event.sessionId === "busy").length >= 6);
});

// History can arrive before the live stream connects, and the server then replays
// the same events. A shared seen-id set is what keeps that from rendering the
// whole transcript twice.
test("a fetched page and the live stream never render the same event twice", () => {
  const store = buffer();
  const knownIds = new Set();
  const historyPage = [
    { ...completedMessage({ seq: 1, sessionId: "s3", turnId: "p:1", text: "历史消息一" }), eventId: "e1" },
    { ...completedMessage({ seq: 2, sessionId: "s3", turnId: "p:1", text: "历史消息二" }), eventId: "e2" },
  ];
  assert.equal(mergeHistory(store.events, store.deltaIndex, historyPage, knownIds), 2);

  // The stream replays those same ids, then a genuinely new one.
  const replayed = [
    { ...completedMessage({ seq: 1, sessionId: "s3", turnId: "p:1", text: "历史消息一" }), eventId: "e1" },
    { ...completedMessage({ seq: 2, sessionId: "s3", turnId: "p:1", text: "历史消息二" }), eventId: "e2" },
    { ...completedMessage({ seq: 3, sessionId: "s3", turnId: "p:1", text: "新消息" }), eventId: "e3" },
  ];
  let added = 0;
  for (const event of replayed) {
    if (knownIds.has(event.eventId)) continue;
    knownIds.add(event.eventId);
    store.add(event);
    added += 1;
  }
  assert.equal(added, 1, "a replayed event was accepted a second time");
  const entries = buildEntries(store.events);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.html.match(/历史消息一|历史消息二|新消息/)?.[0]).filter(Boolean), ["历史消息一", "历史消息二", "新消息"]);
});
