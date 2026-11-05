import path from "node:path";
import { readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";

const dshHome = path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh"));
const profileDir = path.join(dshHome, "profiles", "desktop");
const profilePackagePath = path.join(profileDir, "package.json");

// The plugin was renamed when it moved to npm (`@agentbridge/dsh-phone` ->
// `@chenacc/dsh-agentbridge`). An old install leaves the previous name behind,
// and two names for the same bundle means only one of them loads after a
// restart — so uninstalling has to remove both, not just the current one.
const PACKAGE_NAMES = ["@chenacc/dsh-agentbridge", "@agentbridge/dsh-phone"];
const LEGACY_DIRS = [
  ["@chenacc", "dsh-agentbridge"],
  ["@agentbridge", "dsh-phone"],
];
const installRoots = [
  path.join(profileDir, "node_modules"),
  path.join(dshHome, "profiles", "node_modules"),
];
const installDirs = installRoots.flatMap((root) => LEGACY_DIRS.map((parts) => path.join(root, ...parts)));

try {
  await stat(profilePackagePath);
} catch {
  throw new Error(`DSH Desktop profile was not found at ${profilePackagePath}`);
}

const profile = JSON.parse(await readFile(profilePackagePath, "utf8"));
for (const name of PACKAGE_NAMES) {
  if (profile.dependencies) delete profile.dependencies[name];
  if (Array.isArray(profile.dsh?.profile?.bundles)) {
    profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((entry) => entry !== name);
  }
}
await writeFile(profilePackagePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

for (let index = 0; index < installDirs.length; index += 1) {
  const root = installRoots[Math.floor(index / LEGACY_DIRS.length)];
  const resolvedModulesRoot = path.resolve(root);
  const resolvedInstallDir = path.resolve(installDirs[index]);
  if (!resolvedInstallDir.startsWith(`${resolvedModulesRoot}${path.sep}`)) {
    throw new Error("Refusing to remove a plugin path outside the DSH profile node_modules directory");
  }
  await rm(resolvedInstallDir, { recursive: true, force: true });
}

// A scoped package leaves an empty `@scope` folder behind; remove it when it
// holds nothing else, so an uninstall leaves the profile looking untouched.
for (const root of installRoots) {
  for (const scope of ["@chenacc", "@agentbridge"]) {
    try {
      await rmdir(path.join(path.resolve(root), scope));
    } catch {
      // Not empty (another scoped plugin) or already gone: leave it alone.
    }
  }
}

console.log(`Removed ${PACKAGE_NAMES.join(" and ")} from ${profilePackagePath}`);
console.log("Restart DSH Desktop to unload the command.");
