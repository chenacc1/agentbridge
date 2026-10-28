import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EventStore } from "../src/event-store.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { SessionManager } from "../src/session-manager.js";
import { AttachmentStore, extensionFor, isImage } from "../src/attachments.js";
import { createBridge } from "../src/server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function store(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attachments = new AttachmentStore({ dataDir: directory });
  await attachments.init();
  return { directory, attachments };
}

test("attachments are stored, described and readable after a restart", async (t) => {
  const { directory, attachments } = await store(t);
  const saved = await attachments.save({ sessionId: "s1", name: "报错截图.png", mimeType: "image/png", data: PNG });

  assert.match(saved.id, /^att_/);
  assert.equal(saved.mimeType, "image/png");
  assert.equal(saved.bytes, PNG.length);
  assert.equal(extensionFor("image/png", "x"), ".png");
  assert.equal(extensionFor("application/octet-stream", "notes.md"), ".md");
  assert.equal(extensionFor("application/octet-stream", "noext"), ".bin");
  assert.equal(isImage("image/jpeg"), true);
  assert.equal(isImage("application/pdf"), false);

  const read = await attachments.read(saved.id);
  assert.deepEqual(read.data, PNG);

  // A restart rebuilds the catalog from disk, so a preview URL keeps working.
  const reopened = new AttachmentStore({ dataDir: directory });
  await reopened.init();
  assert.equal(reopened.get(saved.id)?.name, "报错截图.png");
  assert.deepEqual((await reopened.read(saved.id)).data, PNG);
});

test("uploads are bounded in size and per session", async (t) => {
  const { attachments } = await store(t);
  await assert.rejects(
    attachments.save({ sessionId: "s1", name: "big.bin", mimeType: "application/octet-stream", data: Buffer.alloc(attachments.maxBytes + 1) }),
    /不能超过/,
  );
  await assert.rejects(
    attachments.save({ sessionId: "s1", name: "empty.bin", mimeType: "application/octet-stream", data: Buffer.alloc(0) }),
    /empty/,
  );
});

test("a non-image attachment reaches the agent as a path, an image as inline base64", async (t) => {
  const { directory, attachments } = await store(t);
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const sent = [];
  registry.register({
    id: "attach-fixture",
    label: "Attach Fixture",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    async start() { return { providerSessionId: "attach-session" }; },
    async send(_handle, payload) { sent.push(payload); },
  });
  const manager = new SessionManager({
    eventStore,
    registry,
    projects: new Map([["demo", directory]]),
    attachments,
  });
  const device = { id: "phone", deviceName: "Phone" };
  const session = await manager.create({ adapterId: "attach-fixture", projectAlias: "demo", title: "附件", commandId: "attach-create-1", device });

  const image = await attachments.save({ sessionId: session.id, name: "shot.png", mimeType: "image/png", data: PNG });
  const notes = await attachments.save({ sessionId: session.id, name: "notes.md", mimeType: "text/markdown", data: Buffer.from("# 需求\n改登录") });

  await manager.send({
    sessionId: session.id,
    text: "看这两张",
    attachments: [image.id, notes.id],
    commandId: "attach-send-1",
    device,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(sent.length, 1);
  const [payload] = sent;
  assert.equal(payload.text, "看这两张");
  assert.equal(payload.attachments.length, 2);
  const inline = payload.attachments.find((entry) => entry.name === "shot.png");
  assert.equal(inline.isImage, true);
  assert.equal(inline.dataBase64, PNG.toString("base64"));
  const byPath = payload.attachments.find((entry) => entry.name === "notes.md");
  assert.equal(byPath.isImage, false);
  assert.equal(byPath.dataBase64, undefined);
  assert.ok(byPath.path.endsWith(".md"));

  const history = await eventStore.readSessionHistory(session.id, { limit: 10 });
  const message = history.events.find((event) => event.kind === "message.completed" && event.payload.role === "user");
  assert.equal(message.payload.attachments.length, 2);
  assert.equal(message.payload.attachments[0].name, "shot.png");
});

test("an image alone is a valid message, and a foreign attachment is refused", async (t) => {
  const { directory, attachments } = await store(t);
  const eventStore = new EventStore({ filePath: path.join(directory, "events.jsonl") });
  await eventStore.init();
  const registry = new AdapterRegistry();
  const sent = [];
  registry.register({
    id: "attach-fixture",
    label: "Attach Fixture",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    async start() { return { providerSessionId: "attach-session" }; },
    async send(_handle, payload) { sent.push(payload); },
  });
  const manager = new SessionManager({ eventStore, registry, projects: new Map([["demo", directory]]), attachments });
  const device = { id: "phone", deviceName: "Phone" };
  const a = await manager.create({ adapterId: "attach-fixture", projectAlias: "demo", title: "A", commandId: "attach-create-2", device });
  const b = await manager.create({ adapterId: "attach-fixture", projectAlias: "demo", title: "B", commandId: "attach-create-3", device });

  const mine = await attachments.save({ sessionId: a.id, name: "a.png", mimeType: "image/png", data: PNG });
  await manager.send({ sessionId: a.id, text: "", attachments: [mine.id], commandId: "attach-send-2", device });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.length, 1, "an image with no caption still has to go out");

  await assert.rejects(
    manager.send({ sessionId: b.id, text: "偷用", attachments: [mine.id], commandId: "attach-send-3", device }),
    /不属于这个会话/,
  );
});

test("the phone uploads over HTTP, previews it back, and sends it with a message", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-attach-http-"));
  const registry = new AdapterRegistry();
  const sent = [];
  registry.register({
    id: "attach-fixture",
    label: "Attach Fixture",
    capabilities: { create: true },
    detect: async () => ({ available: true, supported: true }),
    async start() { return { providerSessionId: "attach-http-session" }; },
    async send(_handle, payload) { sent.push(payload); },
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
      machineName: "Attachment HTTP",
    },
    registry,
  });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise((resolve) => bridge.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const cookie = (await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  const session = await (await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ adapterId: "attach-fixture", projectAlias: "demo", title: "上传", commandId: "attach-http-1" }),
  })).json();

  const upload = await fetch(`${origin}/api/sessions/${session.session.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "image/png", cookie, origin, "x-attachment-name": encodeURIComponent("截图.png") },
    body: PNG,
  });
  assert.equal(upload.status, 201);
  const { attachment } = await upload.json();
  assert.equal(attachment.name, "截图.png");
  assert.equal(attachment.isImage, true);
  assert.equal(attachment.bytes, PNG.length);

  const preview = await fetch(`${origin}${attachment.previewUrl}`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /image\/png/);
  assert.equal(Buffer.from(await preview.arrayBuffer()).length, PNG.length);

  const send = await fetch(`${origin}/api/sessions/${session.session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ text: "这是报错截图", attachments: [attachment.id], commandId: "attach-http-2" }),
  });
  assert.equal(send.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.at(-1).attachments[0].id, attachment.id);
  assert.equal(sent.at(-1).attachments[0].dataBase64, PNG.toString("base64"));

  // Size limit is enforced before anything is written.
  const tooBig = await fetch(`${origin}/api/sessions/${session.session.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", cookie, origin, "x-attachment-name": "big.bin" },
    body: Buffer.alloc(9 * 1024 * 1024),
  });
  assert.equal(tooBig.status, 413);

  // A device that does not hold the lease cannot write into the conversation.
  const other = (await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } }))
    .headers.get("set-cookie").split(";", 1)[0];
  const stolen = await fetch(`${origin}/api/sessions/${session.session.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "image/png", cookie: other, origin, "x-attachment-name": "x.png" },
    body: PNG,
  });
  assert.equal(stolen.status, 409);
});