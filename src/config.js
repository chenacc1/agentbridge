import os from "node:os";
import path from "node:path";

function firstLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function parseProjects(raw, workspace) {
  if (!raw) return new Map([["workspace", path.resolve(workspace)]]);

  const projects = new Map();
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) throw new Error(`Invalid AGENTBRIDGE_PROJECTS entry: ${part}`);
    const alias = part.slice(0, separator).trim();
    const projectPath = part.slice(separator + 1).trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias) || !projectPath) {
      throw new Error(`Invalid project alias or path: ${part}`);
    }
    projects.set(alias, path.resolve(projectPath));
  }
  if (projects.size === 0) throw new Error("At least one allowed project is required");
  return projects;
}

export function loadConfig(env = process.env, workspace = process.cwd()) {
  const port = Number.parseInt(env.AGENTBRIDGE_PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTBRIDGE_PORT must be a valid TCP port");
  }

  const host = env.AGENTBRIDGE_HOST ?? "0.0.0.0";
  const publicOrigin = (env.AGENTBRIDGE_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  const advertisedOrigin = publicOrigin || `http://${firstLanAddress()}:${port}`;
  const accessKey = (env.AGENTBRIDGE_ACCESS_KEY ?? "").trim() || null;

  return {
    host,
    port,
    advertisedOrigin,
    accessKey,
    secureCookies: advertisedOrigin.startsWith("https://"),
    dataDir: path.resolve(env.AGENTBRIDGE_DATA_DIR ?? path.join(workspace, ".agentbridge")),
    projects: parseProjects(env.AGENTBRIDGE_PROJECTS, workspace),
    pairingTtlMs: Number.parseInt(env.AGENTBRIDGE_PAIRING_TTL_MS ?? "300000", 10),
    sessionTtlMs: Number.parseInt(env.AGENTBRIDGE_SESSION_TTL_MS ?? "259200000", 10),
    machineName: env.AGENTBRIDGE_MACHINE_NAME ?? os.hostname(),
  };
}

export function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
