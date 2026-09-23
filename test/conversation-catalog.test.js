import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { ConversationCatalog } from "../src/conversations/conversation-catalog.js";

test("bridge sessions keep stable ids across restart and reload as offline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-conversations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bridge-sessions.json");
  const firstCatalog = new ConversationCatalog({ filePath });
  await firstCatalog.init();
  const created = await firstCatalog.create({
    workspaceId: "ws_demo",
    projectAlias: "demo",
    adapterId: "codex",
    providerConversationId: "thread-12345678",
    title: "Persistent conversation",
    origin: "phone-created",
    lifecycle: "idle",
    resumable: true,
    attached: false,
  });

  const reloaded = new ConversationCatalog({ filePath });
  await reloaded.init();
  const restored = reloaded.get(created.id);

  assert.equal(restored.id, created.id);
  assert.equal(restored.providerConversationId, "thread-12345678");
  assert.equal(restored.lifecycle, "offline");
  assert.equal(reloaded.findByProvider("codex", "thread-12345678").id, created.id);
  assert.equal("handle" in JSON.parse(await readFile(filePath, "utf8")).items[0], false);
});
