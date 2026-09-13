import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveCommand } from "../src/adapters/process-utils.js";

test("resolveCommand finds a user npm shim when a background PATH omits it", () => {
  const userProfile = "C:\\Users\\AgentBridgeTest";
  const npmBin = path.join(userProfile, "AppData", "Roaming", "npm");
  const expected = path.join(npmBin, "claude.ps1");
  const resolved = resolveCommand("claude", {
    platform: "win32",
    env: { USERPROFILE: userProfile, PATH: "C:\\Windows\\System32" },
    fileExists: (candidate) => candidate === expected,
  });

  assert.equal(resolved, expected);
});
