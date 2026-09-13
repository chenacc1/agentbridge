import test from "node:test";
import assert from "node:assert/strict";
import { PairingManager } from "../src/pairing.js";

test("pairing code is short-lived and single-use", () => {
  let now = 1000;
  const manager = new PairingManager({ pairingTtlMs: 100, sessionTtlMs: 1000, now: () => now });
  const pairing = manager.createPairing("https://example.test");
  const session = manager.exchange(pairing.id, "phone");
  assert.equal(manager.authenticate(session.token).deviceName, "phone");
  assert.throws(() => manager.exchange(pairing.id), /already used/);
  manager.revoke(session.id);
  assert.equal(manager.authenticate(session.token), null);

  const expired = manager.createPairing("https://example.test");
  now += 101;
  assert.throws(() => manager.exchange(expired.id), /expired/);
});

test("pairing can be bound to one bridge session", () => {
  const manager = new PairingManager({ pairingTtlMs: 1000, sessionTtlMs: 1000 });
  const pairing = manager.createPairing("https://example.test", { targetSessionId: "bridge-session-1" });
  const device = manager.exchange(pairing.id, "phone");

  assert.equal(pairing.targetSessionId, "bridge-session-1");
  assert.equal(device.targetSessionId, "bridge-session-1");
  assert.equal(manager.authenticate(device.token).lastSessionId, "bridge-session-1");
  assert.equal(manager.setLastSession(device.id, "bridge-session-2"), true);
  assert.equal(manager.authenticate(device.token).lastSessionId, "bridge-session-2");
});

test("a pairing QR target is available only while that pairing is pending", () => {
  let now = 1000;
  const manager = new PairingManager({ pairingTtlMs: 100, sessionTtlMs: 1000, now: () => now });
  const pairing = manager.createPairing("https://example.test", { targetSessionId: "bridge-session-1" });

  assert.deepEqual(manager.getPendingPairing(pairing.id), pairing);
  manager.exchange(pairing.id, "phone");
  assert.throws(() => manager.getPendingPairing(pairing.id), /invalid, expired, or already used/);

  const expired = manager.createPairing("https://example.test");
  now += 101;
  assert.throws(() => manager.getPendingPairing(expired.id), /invalid, expired, or already used/);
});
