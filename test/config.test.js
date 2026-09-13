import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, isLoopback } from "../src/config.js";

test("config defaults to one allowlisted workspace", () => {
  const root = path.resolve("fixture-workspace");
  const config = loadConfig({ AGENTBRIDGE_PORT: "9999" }, root);
  assert.equal(config.port, 9999);
  assert.equal(config.projects.get("workspace"), root);
  assert.equal(config.sessionTtlMs, 72 * 60 * 60 * 1000);
});

test("config parses project aliases and rejects invalid aliases", () => {
  const config = loadConfig({ AGENTBRIDGE_PROJECTS: "alpha=.\u005capp;docs=.\u005cdocs" }, process.cwd());
  assert.equal(config.projects.size, 2);
  assert.throws(() => loadConfig({ AGENTBRIDGE_PROJECTS: "bad alias=." }), /Invalid project/);
});

test("config advertises an explicit Tailscale origin without changing the local listener", () => {
  const config = loadConfig({
    AGENTBRIDGE_PUBLIC_ORIGIN: "http://100.101.102.103:8787/",
    AGENTBRIDGE_HOST: "0.0.0.0",
  }, process.cwd());
  assert.equal(config.advertisedOrigin, "http://100.101.102.103:8787");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.secureCookies, false);
});

test("loopback detection accepts IPv4 and IPv6 forms", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.2"), false);
});
