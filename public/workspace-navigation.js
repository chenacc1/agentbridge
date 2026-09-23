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
