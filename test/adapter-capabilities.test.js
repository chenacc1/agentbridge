import test from "node:test";
import assert from "node:assert/strict";
import { adapterCreationPresentation } from "../public/adapter-capabilities.js";

test("an available attach-only adapter is not presented as a session creator", () => {
  const presentation = adapterCreationPresentation({
    capabilities: { create: false, attach: true },
    availability: { available: true, supported: true },
  });

  assert.deepEqual(presentation, {
    enabled: false,
    selectable: false,
    blocked: "",
    suffix: "（仅桌面附着）",
  });
});

test("an Agent that names why it cannot create says so instead of claiming to be attach-only", () => {
  const presentation = adapterCreationPresentation({
    capabilities: { create: false, attach: true, createReason: "桌面端离线" },
    availability: { available: true, supported: true },
  });

  assert.equal(presentation.enabled, false);
  assert.equal(presentation.blocked, "桌面端离线");
  assert.equal(presentation.suffix, "（桌面端离线）");
});

test("the same Agent becomes a creator as soon as its companion connects", () => {
  const presentation = adapterCreationPresentation({
    capabilities: { create: true, attach: true },
    availability: { available: true, supported: true },
  });

  assert.equal(presentation.enabled, true);
  assert.equal(presentation.selectable, true);
  assert.equal(presentation.suffix, "");
});
