import test from "node:test";
import assert from "node:assert/strict";
import { absorbEvent, buildEntries, indexDeltas } from "../public/transcript.js";

// The symptom these guard: on a real phone the transcript's clock jumped backwards —
// 11:37 rows above 10:07 rows. The store was in order; the page was not. When the
// event stream reconnects it replays from the last id it saw, and those *older*
// events used to be appended after the newest ones already on screen.

function event({ seq, time, kind = "message.completed", text = "", role = "assistant" }) {
  return {
    v: 1,
    eventId: `e${seq}`,
    seq,
    time,
    sessionId: "s1",
    turnId: "t1",
    kind,
    payload: kind === "message.completed" ? { role, text } : { text },
  };
}

function buffer() {
  const events = [];
  const deltaIndex = indexDeltas(events);
  return { events, deltaIndex, add: (item) => absorbEvent(events, deltaIndex, item) };
}

test("an event replayed after newer ones keeps its chronological place", () => {
  const store = buffer();
  store.add(event({ seq: 30, time: "2026-11-14T03:37:05.000Z", text: "新的回答" }));
  store.add(event({ seq: 31, time: "2026-11-14T03:37:06.000Z", text: "更新的回答" }));
  // A reconnect replays an older batch, which arrives last.
  store.add(event({ seq: 12, time: "2026-11-14T02:07:55.000Z", text: "更早的一步" }));
  store.add(event({ seq: 13, time: "2026-11-14T02:07:59.000Z", text: "更早的第二步" }));

  assert.deepEqual(store.events.map((entry) => entry.seq), [12, 13, 30, 31]);
  const times = store.events.map((entry) => Date.parse(entry.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "the buffer is chronological after the replay");
});

test("a replayed delta still folds into its turn instead of duplicating", () => {
  const store = buffer();
  const delta = (seq, text, offset) => ({
    eventId: `d${seq}`, seq, time: "2026-11-14T03:00:00.000Z", sessionId: "s1", turnId: "t1",
    kind: "message.delta", payload: { role: "assistant", text, offset },
  });
  store.add(delta(1, "你", 0));
  store.add(delta(2, "好", 1));
  // The reconnect replays the same two chunks from the start.
  store.add(delta(1, "你", 0));
  store.add(delta(2, "好", 1));
  assert.equal(store.events.length, 1, "one turn still means one streaming row");
  assert.equal(store.events[0].payload.text, "你好");
});

test("a buffer assembled out of order still renders in order", () => {
  const shuffled = [
    event({ seq: 30, time: "2026-11-14T03:37:05.000Z", text: "新的回答" }),
    event({ seq: 12, time: "2026-11-14T02:07:55.000Z", text: "更早的一步" }),
    event({ seq: 31, time: "2026-11-14T03:37:06.000Z", text: "更新的回答" }),
  ];
  const entries = buildEntries(shuffled);
  assert.deepEqual(entries.map((entry) => entry.key), ["message.completed:e12", "message.completed:e30", "message.completed:e31"]);
});

test("events without a sequence number never jump ahead of the conversation", () => {
  const events = [
    event({ seq: Number.NaN, time: "2026-11-14T03:37:05.000Z", text: "没有序号的" }),
    event({ seq: 5, time: "2026-11-14T02:07:55.000Z", text: "有序号的" }),
  ];
  const entries = buildEntries(events);
  assert.match(entries[0].html, /有序号的/);
});
