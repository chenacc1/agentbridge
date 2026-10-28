function workspaceIdForSession(session, workspaces) {
  if (!session) return null;
  if (session.workspaceId && workspaces.some((workspace) => workspace.id === session.workspaceId)) return session.workspaceId;
  return workspaces.find((workspace) => workspace.alias === session.projectAlias)?.id ?? null;
}

export function sessionsForWorkspace(sessions, workspaces, workspaceId) {
  if (!workspaceId) return [];
  return sessions.filter((session) => workspaceIdForSession(session, workspaces) === workspaceId);
}

export function resolveWorkspaceNavigation({
  workspaces = [],
  sessions = [],
  selectedWorkspaceId = null,
  selectedSessionId = null,
} = {}) {
  const enabledWorkspaces = workspaces.filter((workspace) => workspace.enabled !== false);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedSessionWorkspaceId = workspaceIdForSession(selectedSession, enabledWorkspaces);
  const requestedWorkspace = enabledWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const workspaceId = selectedSessionWorkspaceId ?? requestedWorkspace?.id ?? enabledWorkspaces[0]?.id ?? null;
  const workspaceSessions = sessionsForWorkspace(sessions, enabledWorkspaces, workspaceId);
  const sessionId = selectedSessionWorkspaceId === workspaceId
    ? selectedSession.id
    : workspaceSessions[0]?.id ?? null;
  return { workspaceId, sessionId };
}

export function discoverableAdapters(adapters = []) {
  return adapters.filter((adapter) => (
    adapter?.capabilities?.discover === true
    && adapter?.availability?.available === true
    && adapter?.availability?.supported !== false
  ));
}

// How an Agent's row is labelled and ranked in the drawer. "可以新建" is the
// strongest claim a row can make, so those sort first; an Agent that can only be
// attached from the desktop is useful but cannot open a conversation by itself,
// and an uninstalled Agent must say so instead of offering a dead end.
const CAPABILITY_RANK = { create: 0, attach: 1, unavailable: 2 };

function drawerCapability(adapter) {
  const availability = adapter?.availability ?? {};
  const capabilities = adapter?.capabilities ?? {};
  const usable = availability.available === true && availability.supported !== false;
  if (!usable) return "unavailable";
  return capabilities.create === true ? "create" : capabilities.attach === true ? "attach" : "unavailable";
}

const CAPABILITY_LABEL = { create: "可新建", attach: "仅桌面附着", unavailable: "未安装" };

function lastActiveOf(session) {
  const value = Date.parse(session?.lastActiveAt ?? session?.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function workspaceIdOf(session, workspaces) {
  if (!session) return null;
  if (session.workspaceId && workspaces.some((workspace) => workspace.id === session.workspaceId)) return session.workspaceId;
  return workspaces.find((workspace) => workspace.alias === session.projectAlias)?.id ?? null;
}

function matchesQuery(query, ...fields) {
  if (!query) return true;
  return fields.some((field) => String(field ?? "").toLowerCase().includes(query));
}

/**
 * Build the Agent → project → conversation tree the drawer renders.
 *
 * Structure follows how people actually choose: which tool first, then which
 * project, then which conversation. Two rules keep that from becoming three taps
 * on every visit: an Agent that only has one project skips the project row
 * (`skipProjectRows`), and a search expands every path it matched. Everything is
 * derived here so the drawer stays a renderer and this stays testable.
 */
export function buildAgentDrawer({
  sessions = [],
  workspaces = [],
  adapters = [],
  selectedSessionId = null,
  query = "",
  // `null` means "nothing remembered yet"; an empty array is a real state the
  // user produced by collapsing everything.
  expandedAgents = null,
  // Projects default to open once their Agent is open, so a project only needs
  // remembering when the user closed it. Tracking the exceptions instead of the
  // open set is what keeps "☰ → Agent → conversation" two taps.
  collapsedProjects = [],
} = {}) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const enabledWorkspaces = workspaces.filter((workspace) => workspace.enabled !== false);
  const expandedAgentSet = new Set(Array.isArray(expandedAgents) ? expandedAgents : []);
  const collapsedProjectSet = new Set(Array.isArray(collapsedProjects) ? collapsedProjects : []);

  const groups = adapters.flatMap((adapter) => {
    const capability = drawerCapability(adapter);
    const agentSessions = sessions
      .filter((session) => session.adapterId === adapter.id)
      .sort((a, b) => lastActiveOf(b) - lastActiveOf(a));
    if (!agentSessions.length && capability === "unavailable") {
      // An unavailable Agent with nothing in it is a footnote, not a section.
      return [{
        id: adapter.id,
        label: adapter.label ?? adapter.id,
        capability,
        capabilityLabel: CAPABILITY_LABEL[capability],
        note: adapter.availability?.note ?? null,
        sessionCount: 0,
        expanded: false,
        workspaces: [],
        empty: true,
      }];
    }

    const projects = enabledWorkspaces.flatMap((workspace) => {
      const projectSessions = agentSessions.filter((session) => workspaceIdOf(session, enabledWorkspaces) === workspace.id);
      if (!projectSessions.length) return [];
      return [{
        id: workspace.id,
        name: workspace.name ?? workspace.alias,
        alias: workspace.alias ?? workspace.name,
        sessionCount: projectSessions.length,
        sessions: projectSessions.map((session) => ({
          id: session.id,
          title: session.title ?? "未命名会话",
          status: session.status ?? "offline",
          adapterId: session.adapterId,
          workspaceName: workspace.name ?? workspace.alias,
          lastActiveAt: session.lastActiveAt ?? session.updatedAt ?? null,
          selected: session.id === selectedSessionId,
        })),
      }];
    });
    // Sessions whose workspace is gone still belong to the Agent; dropping them
    // would hide real conversations behind a stale catalog entry.
    const orphaned = agentSessions.filter((session) => !projects.some((project) => project.sessions.some((entry) => entry.id === session.id)));
    if (orphaned.length) {
      projects.push({
        id: `unknown-${adapter.id}`,
        name: "未归属项目",
        alias: "unknown",
        sessionCount: orphaned.length,
        sessions: orphaned.map((session) => ({
          id: session.id,
          title: session.title ?? "未命名会话",
          status: session.status ?? "offline",
          adapterId: session.adapterId,
          workspaceName: session.projectAlias ?? "未归属项目",
          lastActiveAt: session.lastActiveAt ?? session.updatedAt ?? null,
          selected: session.id === selectedSessionId,
        })),
      });
    }

    const sessionCount = projects.reduce((total, project) => total + project.sessionCount, 0);
    const agentMatches = matchesQuery(normalizedQuery, adapter.label, adapter.id);
    const visibleProjects = projects.flatMap((project) => {
      if (!normalizedQuery) return [project];
      const projectMatches = matchesQuery(normalizedQuery, project.name, project.alias);
      const matchingSessions = project.sessions.filter((session) => matchesQuery(normalizedQuery, session.title));
      if (!agentMatches && !projectMatches && !matchingSessions.length) return [];
      return [{
        ...project,
        sessions: agentMatches || projectMatches ? project.sessions : matchingSessions,
        sessionCount: agentMatches || projectMatches ? project.sessionCount : matchingSessions.length,
      }];
    });
    if (normalizedQuery && !visibleProjects.length) return [];

    const visibleSessionCount = visibleProjects.reduce((total, project) => total + project.sessionCount, 0);
    // A search always reveals what it matched. Otherwise the remembered expansion
    // decides — and when nothing is remembered yet, the Agent holding the selected
    // conversation opens by itself, so returning to the app lands on a path the
    // user can see rather than on a collapsed tree.
    const remembered = expandedAgents !== null;
    const holdsSelection = visibleProjects.some((project) => project.sessions.some((session) => session.selected));
    const expanded = normalizedQuery
      ? true
      : remembered
        ? expandedAgentSet.has(adapter.id)
        : holdsSelection;

    return [{
      id: adapter.id,
      label: adapter.label ?? adapter.id,
      capability,
      capabilityLabel: CAPABILITY_LABEL[capability],
      note: adapter.availability?.note ?? null,
      sessionCount: normalizedQuery ? visibleSessionCount : sessionCount,
      expanded,
      empty: false,
      workspaces: visibleProjects.map((project) => ({
        ...project,
        // The project row is only worth a tap when it actually splits something.
        skipProjectRow: visibleProjects.length === 1,
        expanded: normalizedQuery ? true : !collapsedProjectSet.has(project.id),
      })),
    }];
  });

  const visible = groups.filter((group) => !group.empty || !normalizedQuery);
  // Ordering follows what people are actually doing: the tool holding the most
  // recent work comes first, then usable-but-empty tools, and uninstalled ones
  // last. Ranking purely by "can create" would bury DSH Desktop — the one Agent
  // that can only be attached — under tools nobody has used.
  const recentOf = (group) => group.workspaces
    .flatMap((project) => project.sessions)
    .reduce((latest, session) => Math.max(latest, Date.parse(session.lastActiveAt ?? "") || 0), 0);
  return visible.sort((a, b) => {
    const groupRank = (group) => {
      if (group.sessionCount > 0) return 0;
      return group.capability === "unavailable" ? 2 : 1;
    };
    const rank = groupRank(a) - groupRank(b);
    if (rank !== 0) return rank;
    const recency = recentOf(b) - recentOf(a);
    if (Number.isFinite(recency) && recency !== 0) return recency;
    const capability = CAPABILITY_RANK[a.capability] - CAPABILITY_RANK[b.capability];
    if (capability !== 0) return capability;
    return String(a.label).localeCompare(String(b.label));
  });
}

/** "3 分钟前" style label for a drawer row; older entries fall back to a date. */
export function relativeTimeLabel(value, now = Date.now()) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return new Date(time).toLocaleDateString();
}

