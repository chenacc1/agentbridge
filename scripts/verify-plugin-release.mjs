// 发布验收：确认 npm 上的 @chenacc/dsh-agentbridge 是一个"市场能装、DSH 能加载"的插件。
//
// 覆盖四件事：
//   1. registry 元数据（latest、dsh.bundle.patch、license、fileCount）
//   2. tarball 真的包含 cordis.patch.yml / lib/index.js / README / LICENSE
//   3. patch 里插入的 name 与包名一致，入口能作为 ESM 被 import 出 apply/inject/name
//   4. 集成版本号与桥端要求的版本一致，且 /phone 命令确实注册了
//
// 用法：node scripts/verify-plugin-release.mjs [--install]
//   --install 额外在一个临时 profile 里 pnpm add 一次，验证"市场安装路径"

import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PKG = "@chenacc/dsh-agentbridge";
const REGISTRY = "https://registry.npmjs.org";
const REPO_PATH = "integrations/dsh-phone";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function packument() {
  const response = await fetch(`${REGISTRY}/${PKG.replace("/", "%2F")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  // 编码后的路径可能命中旧缓存；回退到不编码的写法（registry 两种都接受）
  if (response.status === 404) {
    const retry = await fetch(`${REGISTRY}/${PKG}`, { signal: AbortSignal.timeout(20_000) });
    if (!retry.ok) throw new Error(`registry returned ${retry.status} for ${PKG}`);
    return retry.json();
  }
  if (!response.ok) throw new Error(`registry returned ${response.status} for ${PKG}`);
  return response.json();
}

async function extractTarball(tarballUrl, dir) {
  const response = await fetch(tarballUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`tarball download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const tgzPath = path.join(dir, "plugin.tgz");
  await writeFile(tgzPath, buffer);
  // stdio 用 inherit：沙箱下 capture 管道会被拒
  await new Promise((resolve, reject) => {
    const child = execFile("tar", ["-xzf", tgzPath, "-C", dir], { stdio: "inherit" }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.on("error", reject);
  });
}

const workdir = await mkdtemp(path.join(tmpdir(), "verify-plugin-"));
try {
  console.log(`\n# 验收 ${PKG}\n`);

  const doc = await packument();
  const version = doc["dist-tags"]?.latest;
  check("registry 有 latest", Boolean(version), version ?? "缺失");
  if (!version) throw new Error("没有 latest 版本，安装无从谈起");

  const manifest = doc.versions[version];
  check("latest 是稳定版（无预发布标记）", !version.includes("-"), version);
  check("manifest 声明 dsh.bundle.patch", Boolean(manifest.dsh?.bundle?.patch), manifest.dsh?.bundle?.patch ?? "缺失");
  check("license 存在", Boolean(manifest.license), manifest.license ?? "缺失");
  check("文件数合理（不应只有 package.json）", (manifest.dist?.fileCount ?? 0) >= 4, `${manifest.dist?.fileCount} 个文件`);

  const repoUrl = (manifest.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
  check(
    "repository 指回被收录的仓库",
    repoUrl === "https://github.com/chenacc1/agentbridge",
    repoUrl || "缺失",
  );
  check(
    "repository.directory 与条目 url 的路径一致",
    manifest.repository?.directory === REPO_PATH,
    manifest.repository?.directory ?? "缺失",
  );

  const extractDir = path.join(workdir, "extract");
  await mkdir(extractDir, { recursive: true });
  await extractTarball(manifest.dist.tarball, extractDir);

  const pkgDir = path.join(extractDir, "package");
  const shippedRaw = await readFile(path.join(pkgDir, "package.json"), "utf8");
  const shipped = JSON.parse(shippedRaw);
  check("tarball 内包名一致", shipped.name === PKG, shipped.name);
  check("tarball 内版本与 latest 一致", shipped.version === version, shipped.version);
  check("tarball 未标记 private", shipped.private !== true, String(shipped.private ?? "false"));

  const patchRaw = await readFile(path.join(pkgDir, "cordis.patch.yml"), "utf8");
  check("cordis.patch.yml 在包里", patchRaw.length > 0);
  check(
    "patch 插入的 name 与包名一致",
    patchRaw.includes(`name: '${PKG}'`) || patchRaw.includes(`name: ${PKG}`),
    patchRaw.trim().split("\n").pop().trim(),
  );

  const entryPath = path.join(pkgDir, "lib", "index.js");
  const entryRaw = await readFile(entryPath, "utf8");
  const mod = await import(pathToFileURL(entryPath).href);
  check("入口可被 Node 作为 ESM 导入", true);
  check("导出 apply 函数", typeof mod.apply === "function");
  check("导出 name / inject", typeof mod.name === "string" && Array.isArray(mod.inject), `${mod.name} inject=[${mod.inject}]`);
  check("注册了 /phone 命令", /name:\s*"phone"/.test(entryRaw) || /name:\s*'phone'/.test(entryRaw));

  const shippedIntegration = Number(entryRaw.match(/INTEGRATION_VERSION\s*=\s*(\d+)/)?.[1] ?? NaN);
  const localChannels = await readFile(
    path.join(process.cwd(), "src", "dsh-desktop-channels.js"),
    "utf8",
  );
  const required = Number(localChannels.match(/integrationStatus\(\{\s*required\s*=\s*(\d+)/)?.[1] ?? NaN);
  check(
    "插件集成版本 ≥ 桥端要求（否则手机端提示「桌面端集成是旧版」）",
    Number.isFinite(shippedIntegration) && Number.isFinite(required) && shippedIntegration >= required,
    `插件 v${shippedIntegration} / 桥要求 v${required}`,
  );

  if (process.argv.includes("--install")) {
    console.log("\n# 走市场安装路径（pnpm add 到临时 profile）\n");
    const profile = path.join(workdir, "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "package.json"),
      JSON.stringify({ name: "dsh-profile-desktop", private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
      "utf8",
    );
    // 用一条 shell 命令串调 pnpm：Windows 上 pnpm 是 .cmd，execFile 直连会 EINVAL；
    // stdio 必须是 inherit——沙箱下管道方式会被拒。
    const storeDir = path.join(workdir, "store");
    await new Promise((resolve, reject) => {
      const child = spawn(
        `pnpm add "${PKG}@${version}" --registry ${REGISTRY} --store-dir "${storeDir}"`,
        { cwd: profile, stdio: "inherit", shell: true },
      );
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pnpm add exited ${code}`))));
    }).catch(() => {});
    const installed = path.join(profile, "node_modules", "@chenacc", "dsh-agentbridge");
    const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    check("pnpm add 安装成功", installedManifest.version === version, installedManifest.version);
    check(
      "安装后 cordis.patch.yml 就地存在",
      (await readFile(path.join(installed, "cordis.patch.yml"), "utf8")).length > 0,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项未通过`}（共 ${results.length} 项）\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await rm(workdir, { recursive: true, force: true });
}
