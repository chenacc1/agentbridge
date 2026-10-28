import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentDrawer, discoverableAdapters, relativeTimeLabel, resolveWorkspaceNavigation, sessionsForWorkspace } from "../public/workspace-navigation.js";

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

const ADAPTERS = [
  { id: "deepseek-harness-desktop", label: "DSH Desktop", availability: { available: true }, capabilities: { create: false, attach: true } },
  { id: "codex", label: "OpenAI Codex", availability: { available: true }, capabilities: { create: true } },
  { id: "claude", label: "Claude Code", availability: { available: true }, capabilities: { create: true } },
  { id: "deepseek-harness", label: "Harness ACP", availability: { available: false }, capabilities: { create: true } },
];
const WORKSPACES = [
  { id: "ws_a", name: "agentbridge", alias: "agentbridge" },
  { id: "ws_b", name: "web-app", alias: "web" },
];
const SESSIONS = [
  { id: "s1", adapterId: "codex", workspaceId: "ws_a", title: "修复登录问题", status: "running", lastActiveAt: "2026-10-26T10:00:00.000Z" },
  { id: "s2", adapterId: "codex", workspaceId: "ws_a", title: "导出报告", status: "ready", lastActiveAt: "2026-10-26T09:00:00.000Z" },
  { id: "s3", adapterId: "codex", workspaceId: "ws_b", title: "重构导航", status: "offline", lastActiveAt: "2026-10-25T09:00:00.000Z" },
  { id: "s4", adapterId: "deepseek-harness-desktop", workspaceId: "ws_a", title: "手机端提问", status: "ready", lastActiveAt: "2026-10-26T10:05:00.000Z" },
  { id: "s5", adapterId: "claude", workspaceId: "ws_b", title: "检查依赖", status: "failed", lastActiveAt: "2026-10-24T09:00:00.000Z" },
];

test("the drawer groups conversations by Agent first, then by project", () => {
  const tree = buildAgentDrawer({ sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS, selectedSessionId: "s1" });
  // Most recent conversation first (DSH Desktop's 10:05 beats Codex's 10:00),
  // then the empty-but-usable tool, then the uninstalled one — not "which tool
  // can create" first, which would bury the attach-only Agent people actually use.
  assert.deepEqual(tree.map((group) => group.id), ["deepseek-harness-desktop", "codex", "claude", "deepseek-harness"]);
  const codex = tree.find((group) => group.id === "codex");
  assert.equal(codex.capability, "create");
  assert.equal(codex.sessionCount, 3);
  assert.deepEqual(codex.workspaces.map((project) => project.id), ["ws_a", "ws_b"]);
  assert.deepEqual(codex.workspaces[0].sessions.map((session) => session.id), ["s1", "s2"]);
  // 2 projects inside one Agent, so the project row is worth showing.
  assert.equal(codex.workspaces[0].skipProjectRow, false);
});

test("an Agent holding only one project skips the project row, and the selected path opens", () => {
  const tree = buildAgentDrawer({ sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS, selectedSessionId: "s4" });
  const desktop = tree.find((group) => group.id === "deepseek-harness-desktop");
  assert.equal(desktop.expanded, true, "the Agent holding the selection should be open on a cold start");
  assert.equal(desktop.workspaces.length, 1);
  assert.equal(desktop.workspaces[0].skipProjectRow, true);
  assert.equal(desktop.workspaces[0].expanded, true);

  const codex = tree.find((group) => group.id === "codex");
  assert.equal(codex.expanded, false, "unrelated Agents start collapsed");
});

test("a remembered collapse beats the selection, and search overrides both", () => {
  const collapsed = buildAgentDrawer({
    sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS,
    selectedSessionId: "s1", expandedAgents: [],
  });
  assert.equal(collapsed.find((group) => group.id === "codex").expanded, false);

  const searched = buildAgentDrawer({
    sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS,
    selectedSessionId: "s1", expandedAgents: [], query: "重构",
  });
  assert.deepEqual(searched.map((group) => group.id), ["codex"], "only the Agent holding a match survives a search");
  const codex = searched[0];
  assert.equal(codex.expanded, true);
  assert.deepEqual(codex.workspaces[0].sessions.map((session) => session.id), ["s3"]);
  assert.equal(codex.sessionCount, 1);
});

test("every Agent is labelled with what it can actually do", () => {
  const tree = buildAgentDrawer({ sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS });
  const labels = Object.fromEntries(tree.map((group) => [group.id, group.capabilityLabel]));
  assert.deepEqual(labels, {
    codex: "可新建",
    claude: "可新建",
    "deepseek-harness-desktop": "仅桌面附着",
    "deepseek-harness": "未安装",
  });
  const unavailable = tree.at(-1);
  assert.equal(unavailable.empty, true);
  assert.equal(unavailable.sessionCount, 0);
  assert.equal(unavailable.expanded, false);
});

test("relative time labels stay readable without a clock", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  assert.equal(relativeTimeLabel("2026-10-26T11:59:40.000Z", now), "刚刚");
  assert.equal(relativeTimeLabel("2026-10-26T11:35:00.000Z", now), "25 分钟前");
  assert.equal(relativeTimeLabel("2026-10-26T08:00:00.000Z", now), "4 小时前");
  assert.equal(relativeTimeLabel("2026-10-25T06:00:00.000Z", now), "昨天");
  assert.equal(relativeTimeLabel("2026-10-20T06:00:00.000Z", now), "6 天前");
  assert.equal(relativeTimeLabel(null, now), "");
});

test("expanding an Agent reveals its conversations without a second tap", () => {
  const expanded = buildAgentDrawer({
    sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS,
    expandedAgents: ["codex"],
  });
  const codex = expanded.find((group) => group.id === "codex");
  assert.equal(codex.expanded, true);
  // Projects are open by default, so the two-project Agent shows every session.
  assert.deepEqual(codex.workspaces.map((project) => project.expanded), [true, true]);
  assert.equal(codex.workspaces.flatMap((project) => project.sessions).length, 3);

  const collapsed = buildAgentDrawer({
    sessions: SESSIONS, workspaces: WORKSPACES, adapters: ADAPTERS,
    expandedAgents: ["codex"], collapsedProjects: ["ws_b"],
  });
  const codexCollapsed = collapsed.find((group) => group.id === "codex");
  assert.deepEqual(codexCollapsed.workspaces.map((project) => project.expanded), [true, false]);
});
