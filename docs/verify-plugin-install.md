# 验证「用户能装上并用起来」

分四层，从便宜到贵。前两层是机器能判的，后两层必须真人操作。

## 第 0 层：发布物自动验收（已自动化）

```powershell
node .\scripts\verify-plugin-release.mjs          # 17 项，验 registry + tarball + 可导入性
node .\scripts\verify-plugin-release.mjs --install # 19 项，额外在临时 profile 里 pnpm add 一次
```

它检查的是"市场允许安装"的几个硬条件，以及"DSH 能加载"的形态：

- registry 有 `latest`、是稳定版、`dsh.bundle.patch = ./cordis.patch.yml`、`license` 存在；
- `repository` 指回被收录的仓库，`repository.directory` 与条目 url 的路径一致（市场的 npm↔仓库关联靠它）；
- tarball 里真的有 `cordis.patch.yml` / `lib/index.js` / `README.md` / `LICENSE`，且包名、版本与 registry 一致；
- patch 里插入的 `name` 与包名一致；
- 入口能被 Node 作为 ESM 导入，导出 `apply` / `name` / `inject`，并注册了 `/phone`；
- 插件里的 `INTEGRATION_VERSION` ≥ 桥端 `integrationStatus({ required })` —— 否则用户会看到"桌面端集成是旧版"。

一次全绿说明**包本身没问题**。它证明不了"在 DSH 里真的能跑"，那是第 1 层往后的事。

## 第 1 层：装进真实 profile（等价于市场安装）

市场的安装动作就是往当前 profile 里 `pnpm add <包>@<精确版本>` 并同步 `dsh.profile.bundles`。手动复现：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add @chenacc/dsh-agentbridge@latest --registry https://registry.npmjs.org
```

然后确认两件事同时成立：

```powershell
# 1. dependencies 里有 @chenacc/dsh-agentbridge
# 2. dsh.profile.bundles 里也有它，且在 @deepseek-ai/dsh-base / dsh-web-app 之后
Get-Content .\package.json -Raw
```

`pnpm add` 不会替你写 `dsh.profile.bundles`，市场会。手动装的话要自己加，否则插件装了不加载。

⚠️ **旧名字必须先清掉。** 改名前的包叫 `@agentbridge/dsh-phone`，两个名字并存时重启只会有一个生效：

```powershell
cd D:\codex_project\手机远程操控agent
npm run uninstall:dsh-phone   # 现在会同时清理新旧两个名字
```

## 第 2 层：插件是否被 DSH 加载

重启 DSH Desktop，在一个**项目会话**里输入 `/phone`。**故意先不要启动桥**，这样能一次验两件事：插件加载了、并且失败时给的是指路信息而不是干瞪眼。

| 看到什么 | 说明 | 下一步 |
|---|---|---|
| 一段"插上已经加载，缺的是电脑上这个本地服务" + 三条 `git clone` / `npm install` / `npm start` 命令（0.1.1 起） | 插件加载成功，文案正确 | 起桥后再敲一次 |
| 弹出二维码 + 配对链接 | 插件加载成功，桥也在跑 | 进入第 3 层 |
| `无法连接 AgentBridge：<原始错误>`（没有那三条命令） | 插件已加载，但桥在线且拒绝了请求 | 看桥的终端输出，多半是配对码过期或令牌不对 |
| 命令根本不存在（或被当成普通文本） | 插件没加载 | 查 `dsh.profile.bundles`、`node_modules/@chenacc/dsh-agentbridge` 是否存在、`%APPDATA%\DSH Desktop\logs` 里的报错 |

第二种最容易被误判成"插件坏了"，其实是插件正常工作、只是缺前置。

## 第 3 层：端到端（用户真正会做的事）

1. 起桥：仓库根 `npm start`（默认 8787）；
2. DSH Desktop 项目会话里 `/phone`；
3. 手机与电脑同一可信 Wi-Fi，微信扫一扫；
4. 在手机上依次验证：
   - 发一条消息 → 桌面端出现同一条用户消息，Agent 开始流式回复，手机同步滚动；
   - 触发一次审批（让 Agent 执行需要批准的命令）→ 手机出现审批卡片，点"允许"后桌面继续；
   - 切换模型 → 只应出现 Agent 真实上报的模型，切换后桌面端的模型也变；
   - 停止 → 桌面端任务真的停下，不是只改了手机界面；
5. 韧性：把桥 `Ctrl+C` 停掉再起，插件应自动重连，桌面日志**不该**出现每秒十条的 `Invalid DSH Desktop channel` 刷屏；
6. 手机端不应出现"桌面端集成是旧版"的提示（出现就是 `INTEGRATION_VERSION` 落后，第 0 层脚本能提前抓到）。

## 第 4 层：干净机器（最有价值，也最容易省掉）

前面三层都在"你已经装好一切"的机器上跑，抓不到这些问题：

- 依赖本机仓库路径（`file:` 依赖、相对路径写死）；
- 依赖你本地已装的 Node / git / pnpm；
- 依赖你 profile 里的其它插件。

做法：另一台 Windows（或新建一个本地用户账户，效果接近），只装 **DSH Desktop + Node 22+**，然后：

1. 从市场装（或 `pnpm add` 一次），重启，`/phone`；
2. 桥必须先跑——干净机器上意味着用户还要自己装 AgentBridge（`git clone` + `npm install` + `npm start`）。**这一步是当前最大的体验断点**：插件装了但没有桥，`/phone` 只会报错。

想彻底消灭这个断点，就得让插件自带依赖并自动拉起桥（下一版的事）。

## 第 5 层：卸载是否干净

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove @chenacc/dsh-agentbridge
# 从 dsh.profile.bundles 删掉同名项，或运行仓库里的 npm run uninstall:dsh-phone
```

重启后 `/phone` 应消失；`node_modules/@chenacc` 与 `@agentbridge` 不应残留空目录；profile 的 `package.json` 应回到安装前形态（我们留了 `.agentbridge-backup` / `.pre-market-backup`）。

## 目前的实际状态（2026-11-05）

- 第 0 层：19 项全绿（含 `pnpm add` 实测），线上 `latest` = `0.1.1`；
- 你的真实 profile 已迁移并升级：旧 `@agentbridge/dsh-phone` 已移除，`@chenacc/dsh-agentbridge@0.1.1` 已装入并写进 `dsh.profile.bundles`；备份在 `package.json.pre-market-backup`；
- 第 2、3 层：**等你重启 DSH Desktop 后测**（先不启桥，验 0.1.1 的指路文案；再起桥验二维码）；
- 第 4 层：还没做，且已知断点是"用户还得自己跑桥"——0.1.1 只是把这条断点讲清楚了，没消除它。
