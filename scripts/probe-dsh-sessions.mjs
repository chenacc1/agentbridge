// Probe the running bridge for DSH Desktop session state. Usage: node scripts/probe-dsh-sessions.mjs
const origin = "http://127.0.0.1:8787";
const local = await fetch(`${origin}/api/local-session`, { method: "POST", headers: { origin } });
const cookie = local.headers.get("set-cookie")?.split(";")[0] ?? "";
const state = await (await fetch(`${origin}/api/state`, { headers: { cookie, origin } })).json();
const dsh = state.sessions.filter((s) => s.adapterId === "deepseek-harness-desktop");
console.log(`${dsh.length} DSH Desktop session(s);`);
for (const s of dsh) {
  console.log(s.id, JSON.stringify({
    title: s.title,
    status: s.status,
    desktopConnected: s.desktopConnected === undefined ? "(bridge older than desktopConnected)" : s.desktopConnected,
    lastError: s.lastError ?? null,
    lastActiveAt: s.lastActiveAt,
  }));
}
console.log("desktopIntegration:", JSON.stringify(state.desktopIntegration));
