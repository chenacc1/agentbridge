import test from "node:test";
import assert from "node:assert/strict";
import { discoverableAdapters, resolveWorkspaceNavigation, sessionsForWorkspace } from "../public/workspace-navigation.js";

const workspaces = [
  { id: "ws_a", alias: "alpha", name: "Alpha", enabled: true },
  { id: "ws_b", alias: "beta", name: "Beta", enabled: true },
];

const sessions = [
  { id: "bs_a", workspaceId: "ws_a", projectAlias: "alpha", title: "A" },
  { id: "bs_b", workspaceId: "ws_b", projectAlias: "beta", title: "B" },
  { id: "bs_legacy", workspaceId: null, projectAlias: "alpha", title: "Legacy A" },
];

test("workspace navigation keeps a selected session and isolates other workspaces", () => {
  assert.deepEqual(resolveWorkspaceNavigation({
    workspaces,
    sessions,
    selectedWorkspaceId: "ws_a",
    selectedSessionId: "bs_b",
  }), { workspaceId: "ws_b", sessionId: "bs_b" });
  assert.deepEqual(sessionsForWorkspace(sessions, workspaces, "ws_a").map((session) => session.id), ["bs_a", "bs_legacy"]);
});

test("workspace navigation selects the first local conversation and allows an empty workspace", () => {
  assert.deepEqual(resolveWorkspaceNavigation({ workspaces, sessions, selectedWorkspaceId: "ws_a" }), {
    workspaceId: "ws_a",
    sessionId: "bs_a",
  });
  assert.deepEqual(resolveWorkspaceNavigation({
    workspaces: [...workspaces, { id: "ws_empty", alias: "empty", name: "Empty", enabled: true }],
    sessions,
    selectedWorkspaceId: "ws_empty",
  }), { workspaceId: "ws_empty", sessionId: null });
});

test("only available adapters with an explicit discover capability appear in history sync", () => {
  const adapters = [
    { id: "codex", capabilities: { discover: true }, availability: { available: true, supported: true } },
    { id: "dsh", capabilities: { discover: false }, availability: { available: true, supported: true } },
    { id: "missing", capabilities: { discover: true }, availability: { available: false } },
    { id: "degraded", capabilities: { discover: true }, availability: { available: true, supported: false } },
  ];
  assert.deepEqual(discoverableAdapters(adapters).map((adapter) => adapter.id), ["codex"]);
});
