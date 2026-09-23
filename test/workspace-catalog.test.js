import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { WorkspaceCatalog } from "../src/workspaces/workspace-catalog.js";

test("workspace registration is durable, deduplicated, and hides local paths from its public view", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentbridge-workspaces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "Demo Workspace");
  await mkdir(workspace);
  const filePath = path.join(directory, "workspaces.json");

  const firstCatalog = new WorkspaceCatalog({
    filePath,
    initialProjects: new Map([["demo", workspace]]),
  });
  await firstCatalog.init();
  const imported = firstCatalog.get("demo");
  const duplicate = await firstCatalog.register({ requestedPath: `${workspace}${path.sep}`, source: "local" });

  assert.equal(duplicate.id, imported.id);
  assert.equal(firstCatalog.list().length, 1);
  assert.deepEqual(firstCatalog.listPublic(), [{ id: imported.id, alias: "demo", name: "Demo Workspace", enabled: true }]);
  assert.equal("canonicalPath" in firstCatalog.listPublic()[0], false);

  const reloaded = new WorkspaceCatalog({ filePath });
  await reloaded.init();
  assert.equal(reloaded.get("demo").id, imported.id);
  assert.equal(reloaded.get(imported.id).canonicalPath, imported.canonicalPath);
});
