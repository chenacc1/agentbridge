# 发布到 DSH 插件市场

目标：让 `@chenacc/dsh-agentbridge` 出现在 DSH Desktop「设置 → 插件市场 → 发现」里，并且可以点一下安装。

## B 已实现：插件加载时自动拉起桥（0.2.0）

目标达成形态：用户从市场装完、重启 DSH Desktop，桥就已经在跑，`/phone` 直接出二维码，中间不需要终端。

实现方式（比原计划更省事）：

- 插件把 `@chenacc/agentbridge` 声明成依赖，用 `import.meta.resolve` 定位 `node_modules/@chenacc/agentbridge/src/server.js`；
- **在 `apply()` 末尾**用 `void startBridge(...).catch(() => {})` 后台启动，**不改 `/phone` 的 handler**——上一版把重试塞进 handler，导致 `node --test` 跑完不退出（根因没定位，改设计后消失）；
- 解析结果必须落在 `node_modules` 里才允许 spawn：否则 Node 的**包自引用**会把本仓库根包解析成 `@chenacc/agentbridge`，开发机上会多起一个桥、抢走 8787；
- 端口取自 `AGENTBRIDGE_ORIGIN`（缺省 8787），子进程 `cwd` 放在 `DSH_HOME` 或用户主目录，避免状态落进桌面进程的启动目录；
- `NODE_TEST_CONTEXT` 下默认禁止 spawn（否则单元测试会真的起服务），只有显式 `AGENTBRIDGE_BRIDGE_ENTRY` 才放行——自动启动的测试就是这么验的；
- 起不来就静默失败，`/phone` 仍然打印手动步骤（`npx @chenacc/agentbridge`）。

验证：`npm test` 204 项全过；`the plugin starts a local bridge when it loads and none is running` 用一个真实 HTTP 桩服务验到"加载即起桥"。

## 两个 npm 包，两条命令

| 包 | npm 名 | 作用 | 用户命令 |
|---|---|---|---|
| 插件（遥控器） | `@chenacc/dsh-agentbridge` | 在 DSH 会话里接出 `/phone` | 市场点安装，或 `pnpm add` 到 profile |
| 桥（基站） | `@chenacc/agentbridge` | 手机控制台的本地服务端 | `npx @chenacc/agentbridge` |

桥用 scope 名不是偏好：`agentbridge` 这个裸名字和已存在的 `agent-bridge@0.6.2` 去掉连字符后完全相同，按 npm 的仿冒防护大概率会被 403 拦下（`dsh-agentbridge` 当初就是被 `dsh-agent-bridge` 卡住的）。直接选 `@chenacc/agentbridge`，省一次失败尝试。

### 桥的发布

```powershell
cd D:\codex_project\手机远程操控agent
npm login --auth-type=web --registry https://registry.npmjs.org   # 登录态过期后需要重做
npm publish --registry https://registry.npmjs.org
```

桥的 `files` 只带 `bin`、`src`、`public`、`.env.example`、`docs/RELEASING.md`——测试、video、scripts 都不进包。发布前 `npm pack --dry-run` 确认 `public/index.html` 和 `src/server.js` 在里面；`bin/agentbridge.js` 用模块相对路径定位 `src/server.js`，所以装在 `node_modules` 里也能自启服务（已用真实 tarball 验过：`phone --agent echo` 会拉起桥并返回配对信息）。

## 先理解机制：市场不存包

市场是个**目录 + npm 安装器**，没有"上传安装包"这一步。链路是：

1. 目录来源（catalog source）返回条目列表，每条只携带**一个 npm 包名**；
2. 用户点安装时，DSH Desktop 去 npm 解析该包的 `latest`；
3. 只有以下三条同时成立，才允许自动安装：
   - npm 包名与目录条目一致；
   - 版本是 npm `latest` 的**稳定精确版本**；
   - 包 manifest 里有合法的 `dsh.bundle.patch` 声明。
4. 安装动作等价于在当前 Desktop profile 里 `pnpm add <包名>@<精确版本>`，并同步 `dsh.profile.bundles`。生命周期脚本（postinstall 等）默认被禁止执行。

内置社区来源：`https://dsh-marketplace.qilewl.net/v1/plugins`（清单 `https://dsh-marketplace.qilewl.net/catalog-source.json`）。另有合作来源（如 dshfind.com、1024Store）。目录收录不等于安全审核，也不承诺兼容性——这一点市场自己也这么写。

## 本次改动（已完成）

| 项 | 位置 | 说明 |
|---|---|---|
| 包名改为 `@chenacc/dsh-agentbridge` | `integrations/dsh-phone/package.json` | 去掉 `private`，与市场的 `dsh-*` 命名惯例一致 |
| `dsh.bundle.patch` 保留 | 同上 | 市场允许自动安装的硬条件 |
| `license: MIT` + LICENSE 文件 | 根目录、`integrations/dsh-phone/LICENSE` | npm 会读包目录里的 LICENSE |
| 发布元数据 | 同上 | `repository` / `homepage` / `bugs` / `keywords` / `engines` / `publishConfig.access=public` |
| 包内 README | `integrations/dsh-phone/README.md` | npm 页面 + 前置条件（先跑 bridge） |
| 插件引用同步改名 | `cordis.patch.yml`、`scripts/install-dsh-phone.mjs`、`scripts/uninstall-dsh-phone.mjs`、`test/install-dsh-phone.test.js` | 安装目录变为 `node_modules/@chenacc/dsh-agentbridge` |

## 已经踩过的坑（2026-11-05 实际发布记录）

这些是这次真发一次包时撞上的，下次发新版或换名字前先看一眼。

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm login` 反复问 `Enter OTP:` | 当时填的是密码不是验证码，而且账号根本没开 2FA | 用 `npm login --auth-type=web`，在浏览器里登录 |
| `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | 账号 `two-factor auth: disabled`，npm 不允许"裸发布" | 发布时会打印 `Authenticate your account at: ...`，在浏览器里点一下授权即可；或开 2FA 后用 `--otp 6位码`；或建一把带 bypass 2FA 的 granular token 写进 `_authToken` |
| `403 Package name too similar to existing package dsh-agent-bridge` | `dsh-agentbridge` 和已存在的 `dsh-agent-bridge` 去掉连字符后完全相同，判为仿冒 | 改用 scoped 名 `@chenacc/dsh-agentbridge`（npm 在报错里直接给了这个方案） |
| 发布后 `npm view` 报 404，但包其实已经在线 | 编码后的 packument URL（`%2F`）命中了旧的 404 缓存；npm 新版发布是异步流水线 | 加 `--prefer-online` 或换一个空缓存目录；直接查未编码斜杠的 `https://registry.npmjs.org/@chenacc/dsh-agentbridge` |
| `npm publish` 只打印 `PUT 202 ... being processed`，退出码 0 | 新版 npm 把发布做成异步处理，几分钟后才对外可用 | 等 2-5 分钟再复查，**不要**因为看到 404 就重复发布 |

已确认的线上状态（`0.1.0`）：`dsh.bundle.patch = ./cordis.patch.yml`、`license = MIT`、5 个文件、`latest` 指向 `0.1.0`；用 `pnpm add @chenacc/dsh-agentbridge@latest` 在空目录实测安装成功，装出来的目录里带 `cordis.patch.yml`。

## 第 1 步：确认包名没被占用

```powershell
npm view @chenacc/dsh-agentbridge version
```

- 返回 `E404` → 名字可用，继续。
- 返回一个版本号 → 已被人发布。改用候选名（`@chenacc/dsh-agentbridge-phone` 等），并同步改 `integrations/dsh-phone/package.json` 的 `name`、`cordis.patch.yml` 的 `name`、两个脚本与测试里的字面量。

同版本号不能重复发布：以后每次发布都要先升 `version`。

## 第 2 步：发布前自检

```powershell
cd integrations\dsh-phone
npm pack --dry-run          # 确认 lib/index.js、cordis.patch.yml、README.md、LICENSE 都在
node --check lib/index.js
cd ..\..
npm run check
npm test
```

`npm pack --dry-run` 里**必须**能看到 `cordis.patch.yml`——少了它，市场会判定"并非标准插件"，不给装。

## 第 3 步：发布到 npm

```powershell
npm login                   # 一次即可
cd integrations\dsh-phone
npm publish                 # publishConfig 已声明 access=public
```

发布后验证（这四条都要成立）：

```powershell
npm view @chenacc/dsh-agentbridge version
npm view @chenacc/dsh-agentbridge dist-tags.latest
npm view @chenacc/dsh-agentbridge dsh.bundle.patch     # 期望输出 ./cordis.patch.yml
npm view @chenacc/dsh-agentbridge license               # 期望 MIT
```

## 第 4 步：按市场的方式自测安装

不要用 `npm run install:dsh-phone`（那是 `file:` 本地复制），要用市场真正走的那条路：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add @chenacc/dsh-agentbridge@latest
```

确认 profile 的 `package.json` 里 `dependencies` 出现 `@chenacc/dsh-agentbridge`、`dsh.profile.bundles` 里也有它；重启 DSH Desktop，在项目会话里输入 `/phone`，看到二维码即通过。测完可以 `pnpm remove @chenacc/dsh-agentbridge` 并清掉 bundles 项。

> 前置条件：本机 AgentBridge 要在跑（`npm start`，默认 8787）。插件自己不是服务端，没有 bridge 时 `/phone` 会返回"无法连接 AgentBridge"。

## 第 5 步：提交收录

界面入口：**设置 → 插件市场 → 发现**页顶部那句"申请收录插件"（英文界面是 "Want your plugin listed?"），指向：

<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

按那份 contributing 的要求提 PR（或先开 issue 询问）。需要准备的材料，基本上就是下面这份：

```markdown
- 展示名：AgentBridge 手机接管
- npm 包：@chenacc/dsh-agentbridge
- 版本：0.1.0
- 仓库：https://github.com/chenacc1/agentbridge （插件目录 integrations/dsh-phone）
- 许可证：MIT
- 分类建议：远程与移动端
- 预览图：https://github.com/chenacc1/agentbridge/blob/main/docs/assets/screen-mobile-1.png
- 一句话简介：在 DSH 会话里敲 /phone，用微信扫码把这条会话接到手机控制台，电脑仍是唯一执行端。
- 长简介：扫码一次性配对；手机上可发消息、审批、切模型、停止；桌面与手机共用同一份事件流；
  凭据与文件访问始终留在本机。需要本机先运行 AgentBridge（默认 127.0.0.1:8787），插件不代装。
- 前置依赖：AgentBridge 主程序 https://github.com/chenacc1/agentbridge
```

审核关注点通常是：包能不能装（`dsh.bundle.patch`）、描述是否夸大、有没有把第三方代码或凭据塞进包里、升级会不会破坏用户环境。我们这份包只有 `lib/index.js` + patch + README + LICENSE，不含二进制、不含 postinstall、不写任何凭据，属于最容易过审的形态。

### 其他收录渠道（可选，可同时投）

| 渠道 | 用途 |
|---|---|
| `https://dsh-marketplace.qilewl.net` | 内置社区来源的站点，找它的提交入口 |
| `https://dshfind.com` | 另一个目录来源，部分用户选它 |
| 1024Store | 市场的合作来源之一 |

## 第 6 步：自己托管一个来源（不等审核的兜底）

市场的来源机制是开放的：任何人发布符合 schema 的公开 HTTPS JSON，用户就能在**设置 → 插件市场 → 高级 → 来源 → 添加标准来源**里填你的清单 URL，立刻看到并安装你的插件，不需要评审或改市场代码。需要两份资源（同一 origin）：

1. `catalog-source.json` 清单（`schemas/catalog-source.schema.json`）；
2. 一个 `GET /v1/plugins` 分页端点，返回 `catalog-provider-page`（支持 `q`、`category`、`cursor`、`limit`）。

可以静态托管在 GitHub Pages / Cloudflare Pages 上，条目里指向 `@chenacc/dsh-agentbridge`。缺点是用户要手动加一次来源。

## 第 7 步：之后每次发版

1. 改 `integrations/dsh-phone/package.json` 的 `version`；
2. `npm publish`；
3. 已安装的用户在市场的「已安装」页会看到「更新」按钮（市场按 npm `latest` 判断，不读目录里的版本号）。

如果改动涉及插件与 bridge 的握手协议，记得同步 `lib/index.js` 里的 `INTEGRATION_VERSION` 和 bridge 侧 `integrationStatus({ required })` 的最低版本要求。

## 已知遗留

- AgentBridge 主程序（bridge）目前还没发 npm，用户要 `git clone` + `npm start`。要做成"市场一键装完即用"，需要让插件自带依赖并自动拉起 bridge——这是下一版的事，届时 `@chenacc/dsh-agentbridge` 要加 `dependencies` 并处理端口占用、配置目录、日志位置。
- 仓库里 `README.md` 的 DSH Desktop 章节仍保留 `npm run install:dsh-phone` 这条开发者路径（本地 `file:` 安装），与市场安装并存，两者不要同时用：同一插件名在两个层里都存在时，重启后只有一个会生效。
