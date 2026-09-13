import path from "node:path";
import { readFile, rm, stat, writeFile } from "node:fs/promises";

const dshHome = path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh"));
const profileDir = path.join(dshHome, "profiles", "desktop");
const profilePackagePath = path.join(profileDir, "package.json");
const installRoots = [
  path.join(profileDir, "node_modules"),
  path.join(dshHome, "profiles", "node_modules"),
];
const installDirs = installRoots.map((root) => path.join(root, "@agentbridge", "dsh-phone"));

try {
  await stat(profilePackagePath);
} catch {
  throw new Error(`DSH Desktop profile was not found at ${profilePackagePath}`);
}

const profile = JSON.parse(await readFile(profilePackagePath, "utf8"));
if (profile.dependencies) delete profile.dependencies["@agentbridge/dsh-phone"];
if (Array.isArray(profile.dsh?.profile?.bundles)) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== "@agentbridge/dsh-phone");
}
await writeFile(profilePackagePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

for (let index = 0; index < installDirs.length; index += 1) {
  const resolvedModulesRoot = path.resolve(installRoots[index]);
  const resolvedInstallDir = path.resolve(installDirs[index]);
  if (!resolvedInstallDir.startsWith(`${resolvedModulesRoot}${path.sep}`)) {
    throw new Error("Refusing to remove a plugin path outside the DSH profile node_modules directory");
  }
  await rm(resolvedInstallDir, { recursive: true, force: true });
}

console.log(`Removed @agentbridge/dsh-phone from ${profilePackagePath}`);
console.log("Restart DSH Desktop to unload the command.");
