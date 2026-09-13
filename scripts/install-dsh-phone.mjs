import path from "node:path";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectRoot, "integrations", "dsh-phone");
const dshHome = path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh"));
const profileDir = path.join(dshHome, "profiles", "desktop");
const profilePackagePath = path.join(profileDir, "package.json");
const backupPath = path.join(profileDir, "package.json.agentbridge-backup");
const installDir = path.join(profileDir, "node_modules", "@agentbridge", "dsh-phone");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(profilePackagePath))) {
  throw new Error(`DSH Desktop profile was not found at ${profilePackagePath}`);
}

const rawProfile = await readFile(profilePackagePath, "utf8");
const profile = JSON.parse(rawProfile);
profile.dependencies ??= {};
profile.dsh ??= {};
profile.dsh.profile ??= {};
profile.dsh.profile.bundles ??= [];

if (!(await exists(backupPath))) await copyFile(profilePackagePath, backupPath);

await mkdir(path.join(installDir, "lib"), { recursive: true });
await Promise.all([
  copyFile(path.join(sourceDir, "package.json"), path.join(installDir, "package.json")),
  copyFile(path.join(sourceDir, "cordis.patch.yml"), path.join(installDir, "cordis.patch.yml")),
  copyFile(path.join(sourceDir, "lib", "index.js"), path.join(installDir, "lib", "index.js")),
]);

profile.dependencies["@agentbridge/dsh-phone"] = `file:${sourceDir.replaceAll("\\", "/")}`;
if (!profile.dsh.profile.bundles.includes("@agentbridge/dsh-phone")) {
  profile.dsh.profile.bundles.push("@agentbridge/dsh-phone");
}
await writeFile(profilePackagePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(`Installed @agentbridge/dsh-phone into ${installDir}`);
console.log(`Updated Desktop profile: ${profilePackagePath}`);
console.log(`Backup: ${backupPath}`);
console.log("Restart DSH Desktop, open a project conversation, then type /phone.");
