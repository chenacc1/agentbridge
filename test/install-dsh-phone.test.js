import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

test("DSH phone installer copies the bundle and updates the Desktop profile idempotently", async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), "agentbridge-dsh-install-"));
  const profileDir = path.join(dshHome, "profiles", "desktop");
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  }), "utf8");
  t.after(() => rm(dshHome, { recursive: true, force: true }));

  const installer = path.resolve("scripts/install-dsh-phone.mjs");
  const env = { ...process.env, DSH_HOME: dshHome };
  await run(process.execPath, [installer], { env });
  await run(process.execPath, [installer], { env });

  const profile = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8"));
  assert.equal(profile.dsh.profile.bundles.filter((name) => name === "@agentbridge/dsh-phone").length, 1);
  assert.match(profile.dependencies["@agentbridge/dsh-phone"], /^file:/);
  const installed = path.join(profileDir, "node_modules", "@agentbridge", "dsh-phone");
  const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.match(await readFile(path.join(installed, "cordis.patch.yml"), "utf8"), /agentbridge-phone/);
  assert.ok(await readFile(path.join(profileDir, "package.json.agentbridge-backup"), "utf8"));

  const uninstaller = path.resolve("scripts/uninstall-dsh-phone.mjs");
  await run(process.execPath, [uninstaller], { env });
  const removedProfile = JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8"));
  assert.equal(removedProfile.dsh.profile.bundles.includes("@agentbridge/dsh-phone"), false);
  assert.equal("@agentbridge/dsh-phone" in removedProfile.dependencies, false);
  await assert.rejects(readFile(path.join(installed, "package.json")), /ENOENT/);
});
