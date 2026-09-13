import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Codex App Server requires HOME even on Windows, where desktop-launched
// processes commonly inherit only USERPROFILE.
export function withHomeEnvironment(env = process.env, homeDirectory = os.homedir(), directoryExists = existsSync) {
  const childEnv = { ...env };
  if (!childEnv.HOME) childEnv.HOME = childEnv.USERPROFILE || homeDirectory;
  if (!childEnv.USERPROFILE && childEnv.HOME) childEnv.USERPROFILE = childEnv.HOME;
  const codexHome = childEnv.HOME ? path.join(childEnv.HOME, ".codex") : null;
  if (!childEnv.CODEX_HOME && codexHome && directoryExists(codexHome)) childEnv.CODEX_HOME = codexHome;
  return childEnv;
}

export function resolveCommand(name, {
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  fileExists = existsSync,
} = {}) {
  if (platform !== "win32") return name;
  const extensions = [".exe", ".com", ".ps1", ".cmd", ".bat"];
  const pathDirectories = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const userProfile = env.USERPROFILE || env.HOME || homeDirectory;
  const appData = env.APPDATA || (userProfile ? path.join(userProfile, "AppData", "Roaming") : null);
  const npmBin = appData ? path.join(appData, "npm") : null;
  if (npmBin && !pathDirectories.some((directory) => directory.replace(/^"|"$/g, "").toLowerCase() === npmBin.toLowerCase())) {
    pathDirectories.push(npmBin);
  }

  for (const directory of pathDirectories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

export function spawnCommand(name, args, options = {}) {
  const resolved = resolveCommand(name);
  if (!resolved) throw Object.assign(new Error(`Command not found: ${name}`), { code: "ENOENT" });
  const childOptions = { ...options, env: withHomeEnvironment(options.env) };
  if (process.platform === "win32" && resolved.toLowerCase().endsWith(".ps1")) {
    const npmBin = path.dirname(resolved);
    const directEntrypoints = {
      codex: {
        executable: process.execPath,
        prefix: [path.join(npmBin, "node_modules", "@openai", "codex", "bin", "codex.js")],
      },
      claude: {
        executable: path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        prefix: [],
      },
      dsh: {
        executable: process.execPath,
        prefix: [path.join(npmBin, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")],
      },
    };
    const direct = directEntrypoints[name];
    if (direct && existsSync(direct.executable) && direct.prefix.every(existsSync)) {
      return spawn(direct.executable, [...direct.prefix, ...args], childOptions);
    }
    return spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolved,
      ...args,
    ], childOptions);
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    throw Object.assign(new Error(`Unsafe command shim without PowerShell alternative: ${resolved}`), { code: "ENOTSUP" });
  }
  return spawn(resolved, args, childOptions);
}

export function probeCommand(name, args = ["--version"]) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand(name, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ available: false, version: null });
      return;
    }
    let output = "";
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ available: false, version: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ available: code === 0, version: output.trim().split(/\r?\n/).at(-1) || null });
    });
  });
}

export function lines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) onLine(line);
  });
}
