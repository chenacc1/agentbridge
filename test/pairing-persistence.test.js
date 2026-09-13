import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { PairingManager } from "../src/pairing.js";

test("sessions persist across manager instances and survive revocation rules", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-pairing-"));
  const storePath = path.join(directory, "sessions.json");
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const first = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 60_000, storePath });
  const session = first.createSession("Phone");
  const revived = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 60_000, storePath });

  const authenticated = revived.authenticate(session.token);
  assert.equal(authenticated?.id, session.id);
  assert.equal(authenticated?.deviceName, "Phone");

  assert.equal(revived.revoke(session.id), true);
  assert.equal(revived.authenticate(session.token), null);

  // The revocation itself is durable: a third instance must not resurrect it.
  const third = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 60_000, storePath });
  assert.equal(third.authenticate(session.token), null);
  assert.equal(third.listDevices().length, 0);
});

test("expired sessions are not reloaded from disk", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-pairing-"));
  const storePath = path.join(directory, "sessions.json");
  t.after(async () => rm(directory, { recursive: true, force: true }));

  let now = 1_000;
  const writer = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 5_000, now: () => now, storePath });
  const session = writer.createSession("Old phone");

  now = 10_000; // past expiry
  const reader = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 5_000, now: () => now, storePath });
  assert.equal(reader.authenticate(session.token), null);
});

test("pairing URLs embed the access key only when configured", () => {
  const withKey = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 60_000, accessKey: "secret-key" });
  assert.match(withKey.createPairing("https://example.com").url, /\/pair\?code=.+\&key=secret-key$/);

  const withoutKey = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 60_000 });
  assert.doesNotMatch(withoutKey.createPairing("https://example.com").url, /key=/);
});

test("listDevices hides revoked and expired entries", () => {
  let now = 1_000;
  const manager = new PairingManager({ pairingTtlMs: 10_000, sessionTtlMs: 5_000, now: () => now });
  const keep = manager.createSession("Keep");
  const drop = manager.createSession("Drop");
  manager.revoke(drop.id);
  now = 7_000; // keep is now expired too

  const fresh = manager.createSession("Fresh");
  const devices = manager.listDevices();
  assert.deepEqual(devices.map((device) => device.id), [fresh.id]);
  assert.equal(devices[0].deviceName, "Fresh");
});
