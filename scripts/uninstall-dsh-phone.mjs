import path from "node:path";
import { readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";

const dshHome = path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh"));
const profileDir = path.join(dshHome, "profiles", "desktop");
const profilePackagePath = path.join(profileDir, "package.json");
const installRoots = [
  path.join(profileDir, "node_modules"),
  path.join(dshHome, "profiles", "node_modules"),
];
const installDirs = installRoots.map((root) => path.join(root, "@chenacc/dsh-agentbridge"));

try {
  await stat(profilePackagePath);
} catch {
  throw new Error(`DSH Desktop profile was not found at ${profilePackagePath}`);
}

const profile = JSON.parse(await readFile(profilePackagePath, "utf8"));
if (profile.dependencies) delete profile.dependencies["@chenacc/dsh-agentbridge"];
if (Array.isArray(profile.dsh?.profile?.bundles)) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== "@chenacc/dsh-agentbridge");
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

// The scoped package leaves an empty `@chenacc` folder behind; remove it when it
// holds nothing else, so an uninstall leaves the profile looking untouched.
for (const root of installRoots) {
  try {
    await rmdir(path.join(path.resolve(root), "@chenacc"));
  } catch {
    // Not empty (another scoped plugin) or already gone: leave it alone.
  }
}

console.log(`Removed @chenacc/dsh-agentbridge from ${profilePackagePath}`);
console.log("Restart DSH Desktop to unload the command.");
