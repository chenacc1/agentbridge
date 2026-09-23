import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapter-registry.js";

test("adapter descriptions expose a normalized conversation capability contract", async () => {
  const registry = new AdapterRegistry();
  registry.register({
    id: "legacy-shaped",
    label: "Legacy Shaped",
    capabilities: { approvals: true, resume: true, stop: true },
    detect: async () => ({ available: true }),
    start() {},
    attach() {},
    stop() {},
    resolveApproval() {},
    selectModel() {},
  });

  const [description] = await registry.describe();

  assert.deepEqual(
    {
      create: description.capabilities.create,
      attach: description.capabilities.attach,
      discover: description.capabilities.discover,
      resume: description.capabilities.resume,
      cancel: description.capabilities.cancel,
      approve: description.capabilities.approve,
      selectModel: description.capabilities.selectModel,
    },
    {
      create: true,
      attach: true,
      discover: false,
      resume: true,
      cancel: true,
      approve: true,
      selectModel: true,
    },
  );
});
