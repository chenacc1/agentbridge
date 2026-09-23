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
    suffix: "（仅桌面附着）",
  });
});
