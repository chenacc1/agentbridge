import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  announceOriginChange,
  announcedOriginPath,
  readAnnouncedOrigin,
  writeAnnouncedOrigin,
} from "../src/origin-announcer.js";
import { describeNotification } from "../src/notifier.js";

function fakeNotifier({ enabled = true, sent = true } = {}) {
  const sentKinds = [];
  return {
    get enabled() { return enabled; },
    sentKinds,
    async send(kind, payload, context) {
      sentKinds.push({ kind, payload, context });
      return { sent, reason: sent ? null : "disabled" };
    },
  };
}

test("the first recorded address is remembered without notifying anyone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-origin-first-"));
  try {
    const notifier = fakeNotifier();
    const messages = [];
    const result = await announceOriginChange({
      dataDir: dir,
      origin: "https://first.trycloudflare.com",
      notifier,
      deviceCount: 3,
      log: (message) => messages.push(message),
    });
    assert.equal(result.announced, false);
    assert.equal(result.reason, "first-run");
    assert.equal(notifier.sentKinds.length, 0, "nothing has moved yet");
    assert.equal(readAnnouncedOrigin(dir), "https://first.trycloudflare.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rebuilt tunnel notifies the paired device with the new address", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-origin-move-"));
  try {
    writeAnnouncedOrigin(dir, "https://old.trycloudflare.com");
    const notifier = fakeNotifier();
    const result = await announceOriginChange({
      dataDir: dir,
      origin: "https://new.trycloudflare.com",
      notifier,
      deviceCount: 1,
      machineName: "我的开发机",
    });
    assert.equal(result.announced, true);
    assert.equal(result.previous, "https://old.trycloudflare.com");
    assert.equal(notifier.sentKinds.length, 1);
    assert.equal(notifier.sentKinds[0].kind, "bridge.moved");
    assert.equal(notifier.sentKinds[0].payload.origin, "https://new.trycloudflare.com");
    assert.equal(readAnnouncedOrigin(dir), "https://new.trycloudflare.com");

    // Same address again: silence.
    const again = await announceOriginChange({ dataDir: dir, origin: "https://new.trycloudflare.com", notifier, deviceCount: 1 });
    assert.equal(again.reason, "unchanged");
    assert.equal(notifier.sentKinds.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no device, no notification — and the address is still recorded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-origin-nodev-"));
  try {
    writeAnnouncedOrigin(dir, "https://old.trycloudflare.com");
    const notifier = fakeNotifier();
    const result = await announceOriginChange({ dataDir: dir, origin: "https://new.trycloudflare.com", notifier, deviceCount: 0 });
    assert.equal(result.reason, "no-devices");
    assert.equal(notifier.sentKinds.length, 0);
    assert.equal(readAnnouncedOrigin(dir), "https://new.trycloudflare.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("notifications switched off do not turn an address change into an error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-origin-off-"));
  try {
    writeAnnouncedOrigin(dir, "https://old.trycloudflare.com");
    const result = await announceOriginChange({
      dataDir: dir,
      origin: "https://new.trycloudflare.com",
      notifier: { enabled: false },
      deviceCount: 2,
    });
    assert.deepEqual({ announced: result.announced, reason: result.reason }, { announced: false, reason: "notifications-disabled" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a webhook that throws never escapes the bridge startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-origin-throw-"));
  try {
    writeAnnouncedOrigin(dir, "https://old.trycloudflare.com");
    const messages = [];
    const result = await announceOriginChange({
      dataDir: dir,
      origin: "https://new.trycloudflare.com",
      notifier: { enabled: true, async send() { throw new Error("network down"); } },
      deviceCount: 1,
      log: (message) => messages.push(message),
    });
    assert.equal(result.announced, false);
    assert.equal(result.reason, "send-failed");
    assert.ok(messages.some((message) => message.includes("network down")), messages.join(" | "));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the recorded address lives next to the rest of the bridge state", () => {
  assert.equal(announcedOriginPath("C:\\state"), path.join("C:\\state", "advertised-origin.json"));
});

test("the announcement message names the new address and what to do", () => {
  const shaped = describeNotification("bridge.moved", { previous: "https://old.example", origin: "https://new.example" }, { sessionTitle: "我的开发机" });
  assert.match(shaped.title, /地址已更换/);
  assert.match(shaped.text, /https:\/\/new\.example/);
  assert.match(shaped.text, /重新执行 \/phone/);
});
