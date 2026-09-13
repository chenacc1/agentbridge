import test from "node:test";
import assert from "node:assert/strict";
import { CcSwitchModelCatalog } from "../src/cc-switch-models.js";

function reader(files) {
  return async (filePath) => {
    const value = files.find(([suffix]) => filePath.endsWith(suffix))?.[1];
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  };
}

function database(endpoint) {
  return () => ({
    prepare: () => ({ get: () => endpoint ? { url: endpoint } : undefined }),
    close: () => {},
  });
}

test("CC Switch exposes only Kimi's allowlisted models for its active Kimi provider", async () => {
  const catalog = new CcSwitchModelCatalog({
    homeDir: "C:\\TestUser",
    readFile: reader([
      [".cc-switch\\settings.json", JSON.stringify({ currentProviderClaude: "provider-kimi" })],
      [".claude\\settings.json", JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_MODEL: "kimi-for-coding",
        ANTHROPIC_API_KEY: "must-not-leak",
      } })],
    ]),
    openDatabase: database("https://api.kimi.com/coding"),
  });

  const directory = await catalog.current();
  assert.equal(directory.source, "cc-switch");
  assert.deepEqual(directory.current, { provider: "cc-switch:kimi", model: "kimi-for-coding" });
  assert.deepEqual(directory.groups[0].models.map((model) => model.id), ["kimi-for-coding", "k3-256k", "k3"]);
  assert.equal(JSON.stringify(directory).includes("must-not-leak"), false);
});

test("CC Switch model catalog stays unavailable for an unknown active endpoint", async () => {
  const catalog = new CcSwitchModelCatalog({
    homeDir: "C:\\TestUser",
    readFile: reader([
      [".cc-switch\\settings.json", JSON.stringify({ currentProviderClaude: "provider-unknown" })],
      [".claude\\settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.invalid/v1" } })],
    ]),
    openDatabase: database("https://example.invalid/v1"),
  });

  assert.equal(await catalog.current(), null);
});

test("CC Switch model catalog refuses Kimi selection when Claude's applied endpoint is stale", async () => {
  const catalog = new CcSwitchModelCatalog({
    homeDir: "C:\\TestUser",
    readFile: reader([
      [".cc-switch\\settings.json", JSON.stringify({ currentProviderClaude: "provider-kimi", enableLocalProxy: false })],
      [".claude\\settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } })],
    ]),
    openDatabase: database("https://api.kimi.com/coding"),
  });

  assert.equal(await catalog.current(), null);
});
