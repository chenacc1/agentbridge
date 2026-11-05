import test from "node:test";
import assert from "node:assert/strict";
import { DshDesktopChannelManager } from "../src/dsh-desktop-channels.js";
import { DshDesktopAdapter } from "../src/adapters/dsh-desktop.js";

// A DSH Desktop conversation is driven by a companion inside the desktop app that
// polls this bridge every 800 ms. Closing or restarting that app leaves the channel
// object in this process untouched, so "the channel exists" was never the same
// question as "someone is reading the commands". These tests move the clock instead
// of waiting, because the whole point is what happens after nothing arrives.

function withClock(t) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => {
    Date.now = realNow;
  });
  return {
    advance(ms) {
      offset += ms;
    },
  };
}

function register(channels, providerSessionId, integrationVersion = 6) {
  return channels.register({
    providerSessionId,
    cwd: "D:\\work",
    title: "DSH test",
    integrationVersion,
  });
}

test("a companion that stopped polling is no longer reported as connected", (t) => {
  const clock = withClock(t);
  const channels = new DshDesktopChannelManager();
  const channel = register(channels, "dsh-live-session");

  assert.equal(channels.isOnline(channel.providerSessionId), true);
  assert.equal(channels.hasOnlineChannel(), true);

  // The desktop app was closed: nothing polls, but the channel object stays.
  clock.advance(90_000);

  assert.equal(channels.isOnline(channel.providerSessionId), false);
  assert.equal(channels.hasOnlineChannel(), false);
  assert.equal(channels.integrationStatus().paired, false);
  assert.throws(
    () => channels.enqueue(channel.providerSessionId, { kind: "message", text: "hi" }),
    (error) => error.statusCode === 409 && error.message.includes("/phone"),
  );
  assert.throws(
    () => channels.attachBridge(channel.providerSessionId, { onEvent() {} }),
    (error) => error.statusCode === 409 && error.message.includes("/phone"),
  );
  // Creating a conversation from the phone needs a carrier that is actually reading.
  assert.throws(
    () => channels.requestSession({ cwd: "D:\\work", bridgeSessionId: "bs_stale_carrier" }),
    (error) => error.statusCode === 409,
  );
});

test("the next poll revives the channel, so a reconnect is not a dead end", (t) => {
  const clock = withClock(t);
  const channels = new DshDesktopChannelManager();
  const channel = register(channels, "dsh-reviving-session");

  clock.advance(90_000);
  assert.equal(channels.isOnline(channel.providerSessionId), false);

  const polled = channels.poll(channel.id, channel.token, 0);
  assert.equal(Array.isArray(polled.commands), true);
  assert.equal(channels.isOnline(channel.providerSessionId), true);
  const queued = channels.enqueue(channel.providerSessionId, { kind: "message", text: "back" });
  assert.equal(queued.seq, 1);
});

test("a stop for a dead desktop channel is refused instead of vanishing into the queue", async (t) => {
  const clock = withClock(t);
  const channels = new DshDesktopChannelManager();
  const channel = register(channels, "dsh-stop-session");
  const adapter = new DshDesktopAdapter({ channels });
  const handle = await adapter.attach({ emit: async () => {} }, channel.providerSessionId);

  clock.advance(90_000);
  await assert.rejects(
    adapter.stop(handle),
    (error) => error.statusCode === 409 && error.message.includes("/phone"),
  );
  await assert.rejects(
    adapter.send(handle, { text: "hello", commandId: "delivery-after-death" }),
    (error) => error.statusCode === 409,
  );
});

test("the reported integration version only comes from channels that are alive", (t) => {
  const clock = withClock(t);
  const channels = new DshDesktopChannelManager();
  register(channels, "dsh-old-and-silent", 4);
  clock.advance(90_000);
  register(channels, "dsh-current-and-polling", 6);

  const status = channels.integrationStatus();
  assert.equal(status.paired, true);
  assert.equal(status.version, 6, "a silent v4 channel must not age a live v6 one");
  assert.equal(status.stale, false);

  // Once even the live one goes quiet, nothing is paired — the phone is told to run
  // /phone instead of being shown a version it cannot act on.
  clock.advance(90_000);
  assert.deepEqual(channels.integrationStatus(), { paired: false, version: null, required: 6, stale: false });
});
