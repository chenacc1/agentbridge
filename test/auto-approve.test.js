import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";
import { createBridge } from "../src/server.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-autoapprove-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const state = { emit: null, approvals: [] };
  registry.register({
    id: "approve-fixture",
    label: "Approve Fixture",
    capabilities: { create: true, approve: true, answer: true },
    detect: async () => ({ available: true, supported: true }),
    async start(context) {
      state.emit = context.emit;
      return { providerSessionId: "approve-fixture-session" };
    },
    async send() {},
    async resolveApproval(_handle, approvalId, decision) {
      state.approvals.push({ approvalId, decision });
      return true;
    },
    async resolveInput() { return true; },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]) });
  const device = { id: "phone-a", deviceName: "Phone" };
  const session = await manager.create({
    adapterId: "approve-fixture",
    projectAlias: "demo",
    title: "自动放行",
    commandId: "auto-approve-create-1",
    device,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { manager, eventStore, state, device, session };
}

const request = (toolName) => ({ approvalId: `approval-${toolName}`, method: toolName, request: { toolName } });

test("with no policy an approval still waits for the phone", async (t) => {
  const { state } = await fixture(t);
  await state.emit("approval.requested", request("shell"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(state.approvals, []);
});

test("an armed policy answers matching approvals and leaves the rest blocked", async (t) => {
  const { manager, state, device, session } = await fixture(t);

  const granted = await manager.setAutoApproval({
    sessionId: session.id,
    minutes: 10,
    tools: ["shell"],
    commandId: "auto-approve-grant-1",
    device,
  });
  assert.ok(granted.autoApprove.until > Date.now());
  assert.deepEqual(granted.autoApprove.tools, ["shell"]);

  await state.emit("approval.requested", request("shell"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(state.approvals, [{ approvalId: "approval-shell", decision: "approve" }]);

  // A different tool is not covered by the scope.
  await state.emit("approval.requested", request("network"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(state.approvals.length, 1);

  // Turning it off restores the normal behaviour immediately.
  const cleared = await manager.setAutoApproval({ sessionId: session.id, minutes: 0, commandId: "auto-approve-clear-1", device });
  assert.equal(cleared.autoApprove, null);
  await state.emit("approval.requested", request("shell"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(state.approvals.length, 1);
});

test("the policy is capped at thirty minutes and refuses nonsense", async (t) => {
  const { manager, device, session } = await fixture(t);

  const capped = await manager.setAutoApproval({ sessionId: session.id, minutes: 600, commandId: "auto-approve-cap-1", device });
  const remaining = capped.autoApprove.until - Date.now();
  assert.ok(remaining <= 30 * 60_000 + 1000, `a ten hour request turned into ${remaining} ms`);
  assert.deepEqual(capped.autoApprove.tools, ["*"]);

  await assert.rejects(
    manager.setAutoApproval({ sessionId: session.id, minutes: 0.1, commandId: "auto-approve-cap-2", device }),
    /at least one minute/,
  );
  await assert.rejects(
    manager.setAutoApproval({ sessionId: session.id, minutes: "soon", commandId: "auto-approve-cap-3", device }),
    /must be a number/,
  );
});

test("only the controlling device may arm or disarm the policy", async (t) => {
  const { manager, session } = await fixture(t);
  await assert.rejects(
    manager.setAutoApproval({ sessionId: session.id, minutes: 5, commandId: "auto-approve-other-1", device: { id: "other", deviceName: "Other" } }),
    /接管输入/,
  );
});

test("every public session payload carries the live policy", async (t) => {
  const { manager, device, session } = await fixture(t);
  await manager.setAutoApproval({ sessionId: session.id, minutes: 5, tools: ["shell", "fs"], commandId: "auto-approve-view-1", device });
  const listed = manager.list().find((entry) => entry.id === session.id);
  assert.ok(listed.autoApprove, "list() lost the policy");
  assert.deepEqual(listed.autoApprove.tools, ["shell", "fs"]);
  assert.equal(listed.autoApprove.deviceName, "Phone");
});

test("an expired policy stops auto-approving without being cleared", async (t) => {
  const { manager, state, device, session } = await fixture(t);
  await manager.setAutoApproval({ sessionId: session.id, minutes: 60, commandId: "auto-approve-expire-1", device });
  // Rewrite the deadline into the past: the check is time-based, not event-based.
  manager.get(session.id).autoApprove.until = Date.now() - 1;
  assert.equal(manager.list().find((entry) => entry.id === session.id).autoApprove, null);

  await state.emit("approval.requested", request("shell"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(state.approvals, []);
});
test("the phone can arm and revoke the policy over HTTP, and only the owner may do it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-autoapprove-http-"));
  const registry = new AdapterRegistry();
  const approvals = [];
  registry.register({
    id: "approve-fixture",
    label: "Approve Fixture",
    capabilities: { create: true, approve: true },
    detect: async () => ({ available: true, supported: true }),
    async start() { return { providerSessionId: "approve-http-session" }; },
    async send() {},
    async resolveApproval(_handle, approvalId, decision) { approvals.push({ approvalId, decision }); return true; },
  });
  const bridge = await createBridge({
    config: {
      host: "127.0.0.1",
      port: 0,
      advertisedOrigin: "http://127.0.0.1:0",
      secureCookies: false,
      dataDir: directory,
      projects: new Map([["demo", directory]]),
      pairingTtlMs: 10_000,
      sessionTtlMs: 60_000,
      machineName: "Auto approve HTTP",
    },
    registry,
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  // One hook, in dependency order: the server has to be down before its data dir goes.
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const cookie = (await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  const created = await (await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ adapterId: "approve-fixture", projectAlias: "demo", title: "HTTP 放行", commandId: "aa-http-create-1" }),
  })).json();

  const armed = await fetch(`${origin}/api/sessions/${created.session.id}/auto-approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ minutes: 15, tools: ["shell"], commandId: "aa-http-arm-1" }),
  });
  assert.equal(armed.status, 200);
  const armedBody = await armed.json();
  assert.ok(armedBody.autoApprove.until > Date.now());
  assert.deepEqual(armedBody.autoApprove.tools, ["shell"]);

  const state = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
  const listed = state.sessions.find((session) => session.id === created.session.id);
  assert.deepEqual(listed.autoApprove.tools, ["shell"], "the phone's state does not carry the policy");

  // A second device cannot touch it: the policy belongs to the controlling phone.
  const otherCookie = (await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  const stolen = await fetch(`${origin}/api/sessions/${created.session.id}/auto-approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherCookie, origin },
    body: JSON.stringify({ minutes: 5, commandId: "aa-http-arm-2" }),
  });
  assert.equal(stolen.status, 409);

  const revoked = await fetch(`${origin}/api/sessions/${created.session.id}/auto-approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ minutes: 0, commandId: "aa-http-off-1" }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).autoApprove, null);
  assert.deepEqual(approvals, []);
});