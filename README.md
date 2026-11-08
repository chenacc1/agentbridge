# AgentBridge

> 用手机（微信扫码即可）查看、继续或停止这台电脑上正在运行的编程 Agent。凭据和文件访问始终留在本机，手机只下发命令。
>
> 默认走 Cloudflare 隧道：手机用流量、在外地都能打开，不必和电脑连同一个 Wi-Fi；隧道对外开放，因此自动带一道访问密钥门禁。

![AgentBridge 架构：电脑上的本地 Bridge 连接已配对手机，并调用获准的编程 Agent 适配器。](./docs/assets/architecture.svg)

手机与桌面共享同一份可追加事件流，因此消息、工具活动、审批和任务状态始终同步。电脑是唯一的执行端：手机只运行界面，不运行 Agent，也拿不到任何供应商凭据。

**当前版本：** 桥 `@chenacc/agentbridge` **0.1.4** · DSH 插件 `@chenacc/dsh-agentbridge` **0.3.3**（两个包各自发布，见文末「版本与发布」）。

## 它是怎么工作的

![三端结构：手机控制面、本地 Bridge、电脑执行端](./docs/assets/keyframe-02-three-tier.jpg)

1. **手机** 只负责界面与指令：扫码进入 H5 控制台，选工作区、选会话，发出消息、审批与停止命令。
2. **本地 Bridge** 是唯一枢纽：校验设备、维持会话与输入租约，把命令写进可追加事件流，再经 SSE 推回手机。
3. **电脑上的 Agent 子进程** 真正执行任务，凭据与文件访问始终留在本机，手机侧拿不到。

远程时中间多一跳，但入口仍然是桥：

```
手机 ──公网 HTTPS──> Cloudflare 边缘 ──隧道──> cloudflared（你电脑上的进程）
                                                      │
                                                      ▼
                                        AgentBridge 桥（127.0.0.1:8787）
                                                      │
                                                      ▼
                            Claude Code / Codex / DeepSeek Harness / DSH Desktop 里的那条会话
```

因为上行与下行共用同一条事件流，桌面端和手机看到的是同一份状态，而不是两套各自猜测的界面。

> 本文中标注为「分镜关键帧」的图片是讲解视频的概念示意图，用于说明结构关系；真实界面见下文「界面」一节。

## 主要能力

- **扫码配对**：一次性、5 分钟有效的二维码；配对后收藏固定回访地址，之后免扫码进入。
- **跨网络直接可用**：默认自动开 Cloudflare 隧道，二维码就是公网 https 地址，手机无需安装任何 App。
- **工作区 → 会话导航**：一个抽屉管理「Agent → 项目 → 会话」，Bridge 重启后历史与会话不丢失。
- **完整对话控制**：流式输出、停止、接管输入、翻看历史，表格 / 公式 / 代码块正确渲染。
- **远程协作**：审批卡片、提问卡片、限时自动放行（5/10/30 分钟）、消息排队、会话内搜索。
- **手机输入**：上传图片与文件、语音转文字、一键复制命令。
- **模型切换**：只使用 Agent 真实上报的模型目录，绝不编造模型名。
- **通知推送**：需要你处理时推送到企业微信 / Telegram / ServerChan / PushPlus。
- **多 Agent 统一接入**：Codex、Claude Code、DeepSeek Harness、DSH Desktop、ZCode（官方跳转）。

## 安装到你的电脑

![从本机启动到手机控制的四步流程。](./docs/assets/phone-flow.svg)

### 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **22 或更高**，`node -v` 确认 |
| 操作系统 | Windows（一键脚本齐全）；Linux / macOS 直接用 `npm start` |
| Agent 工具 | 可选，按需安装：Claude Code / Codex / DeepSeek Harness / DSH Desktop |
| cloudflared | **不需要手动准备**：缺了会自动下载（见下一节） |

AgentBridge 不替你安装或登录任何 Agent，只检测本机**已安装且已登录**的那些；没装的显示「未安装」，不会假装可用。

### 两种装法

**想马上用（推荐）**：不用下载仓库，一条命令起桥并直接打印二维码。

```powershell
npx @chenacc/agentbridge
```

要长期使用、或改配置（项目白名单、远程通道、通知推送），装成全局命令：

```powershell
npm install -g @chenacc/agentbridge
agentbridge phone --agent claude
```

**要改代码或跑测试**：从仓库来。

```powershell
git clone https://github.com/chenacc1/agentbridge.git
cd agentbridge
npm install
$env:AGENTBRIDGE_PROJECTS = "agentbridge=D:\projects\agentbridge"   # 可选：别名=绝对路径，分号分隔
npm start
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，桌面页会显示一次性二维码，用微信「扫一扫」即可。

> 二维码只用于首次配对，会过期且**只能使用一次**。配对成功后请收藏手机页显示的固定回访地址，之后从收藏进入；不要收藏 `/pair?code=...` 临时链接。
> `AGENTBRIDGE_PROJECTS` 可以不写：不设时默认把**启动目录**作为唯一可用项目，别名 `workspace`。别名只允许字母、数字、`_`、`-`（≤40 字符）。
> 这些变量必须设在**真正启动 Bridge 的那个终端**里；`.env.example` 只是一份清单，程序不会自动读取 `.env` 文件。

### 装完自检

```powershell
npx @chenacc/agentbridge phone --agent echo
# 从仓库跑的话：node .\bin\agentbridge.js phone --agent echo
```

Echo 适配器不接触任何 AI 工具，只验证「CLI → 本机 Bridge → 生成配对二维码」整条链路。能打印二维码就说明安装正确，扫码后可看到手机与桌面同步。终端里除了二维码，还会打出两行关键信息：

```
网络: 公网地址，手机用流量也能打开
微信扫码地址: https://xxx.trycloudflare.com/pair?code=…&key=…
```

第一次运行会自动下载 `cloudflared`（约 55 MB），所以首次可能要等几秒到几十秒；之后再运行就是秒级。

## 网络与远程接入

### 二维码里的地址是怎么定的

CLI 和插件共用同一套逻辑（`src/remote.js`），按下面的顺序决定二维码写什么：

| 优先级 | 条件 | 二维码地址 |
|---|---|---|
| 1 | 设了 `AGENTBRIDGE_PUBLIC_ORIGIN` | 你给的那个（Tailscale、ZeroTier、自己的域名都走这条） |
| 2 | 已有桥正在用公网地址运行 | 复用它，不再开新通道 |
| 3 | 设了 `AGENTBRIDGE_NO_TUNNEL=1` 或 `AGENTBRIDGE_REMOTE=lan` | 局域网 |
| 4 | `AGENTBRIDGE_REMOTE` 指定了某一条（`funnel` / `named` / `tailscale` / `zerotier` / `cloudflare`） | 只试那一条 |
| 5 | 默认 `auto` | 按下面「五种远程路径」的顺序试，成功即停 |
| 6 | 全都不成立 | 局域网，日志里逐条说明每条为什么失败 |

### 五种远程路径

`auto`（默认）的尝试顺序：**命名隧道 → Funnel → Cloudflare quick → Tailscale → ZeroTier → 局域网**。下表的“自动”指装好就能用、不需要你手动跑脚本。

| 路径 | 自动？ | 手机要求 | 代价 |
|---|---|---|---|
| Cloudflare quick tunnel | ✅ 缺 `cloudflared` 会自己下 | 只需浏览器 | 域名每次重建会变 |
| 局域网 | ✅ 兜底 | 浏览器 / 微信 | 出门就不可用 |
| Tailscale（私有地址） | ✅ 已登录且在线才用 | 同一 tailnet（装 App） | 手机要常驻 VPN 类 App |
| ZeroTier（私有地址） | ✅ 检测到 ZeroTier 网卡才用 | 同一私有网络（装 App） | 同上 |
| Tailscale Funnel | 🟡 需 `AGENTBRIDGE_REMOTE=funnel` 显式开启；`auto` 只复用已开启的 | 只需浏览器 | 要在 Tailscale 管理台开启 Funnel |
| Cloudflare 命名隧道 | 🟡 需配隧道名 + 域名 | 只需浏览器 | 域名要托管在 Cloudflare |

Funnel 单独放在“要显式开启”这一档，是因为开启它会改动你 tailnet 的对外暴露配置——这种事不该由一次扫码替你决定。反过来，**已经开着的** Funnel 会被 `auto` 直接复用。

只想用某一条路径：

```powershell
$env:AGENTBRIDGE_REMOTE = "funnel"    # 或 named | cloudflare | tailscale | zerotier | lan
agentbridge phone --agent claude
```

命名隧道需要两个变量：

```powershell
$env:AGENTBRIDGE_CLOUDFLARE_TUNNEL = "agentbridge"        # cloudflared 里已经建好的隧道名
$env:AGENTBRIDGE_CLOUDFLARE_HOSTNAME = "bridge.example.com"
```

当前路径会同时出现在三个地方：CLI 输出的「网络:」一行、桥启动日志的 `Remote path:` 一行、`/api/health` 的 `remoteProvider` 字段——二维码打不开时先看这三处。

![分镜关键帧：四条网络路径分别接入同一台 Windows Host，其中 Cloudflare 路径还要经过一道访问密钥门禁](./docs/assets/keyframe-09-network-paths.jpg)

任何模式都**不要**把 TCP 8787 直接映射到公网。Cloudflare 模式会额外启用访问密钥闸门，光有二维码不够。

### cloudflared 是自动的

插件和 CLI 都会先在本机找 `cloudflared`（PATH、两处 Program Files、winget 目录、`~/.agentbridge/bin`），都找不到时才从 Cloudflare 官方的 GitHub Releases 下载一份到 `%USERPROFILE%\.agentbridge\bin\cloudflared.exe`：不要管理员权限、不写系统目录、删掉那个文件夹就等于卸载。下载完会先跑一次 `cloudflared --version`，验不过的文件不会留下。

想自己装也行（`winget install --id Cloudflare.cloudflared`），已装的那份优先。断网或代理挡住下载时，一切照常，只是退回局域网。

### 访问密钥：会不会变、怎么换

密钥就是一句口令，不是账号。它只在**对公网开放时**生效（quick tunnel / 命名隧道）；局域网、Tailscale、ZeroTier 默认没有门禁，也就不会有人问你密钥。门禁打开时，所有非本机（loopback）请求都必须带上它：二维码里已内嵌 `?key=…`，手机用它换一个 90 天有效的 cookie（`agentbridge_key`）。

密钥文件有两个位置，取决于谁在开隧道：

| 谁来开隧道 | 密钥文件 |
|---|---|
| CLI / DSH 插件（默认路径） | `%USERPROFILE%\.agentbridge\access-key` |
| 仓库里的一键脚本 `.cmd` | `<仓库>\.agentbridge\access-key` |

两者都是**先读后写**：文件存在、内容非空且不短于 16 个字符就原样复用，所以重启、换端口、换隧道地址都不会改它。会变的只有三种情况：删掉（或清空、或写短于 16 个字符）该文件；换了一份代码目录；该目录第一次以 Cloudflare 模式启动。

**换法**（三步，不需要改代码）：

```powershell
# 1. 停掉桥（安全停止脚本，或结束占用 8787 的进程）
scripts\stop-agentbridge.ps1

# 2a. 让下次启动生成新串
Remove-Item "$env:USERPROFILE\.agentbridge\access-key"
# 或者直接写自己的口令（≥16 字符，别加换行）：
# "my-own-long-passphrase" | Set-Content "$env:USERPROFILE\.agentbridge\access-key" -NoNewline -Encoding ascii

# 3. 重启（重启 DSH Desktop，或再跑一次 agentbridge phone）
```

换完所有手机都要重新扫码（旧 cookie 不再匹配）。`.agentbridge/` 已在 `.gitignore` 中，密钥不会进版本库；但也别把带 `?key=` 的完整链接贴到公开场合。推送通知的跳转链接默认**不带**密钥（`notifyLink` 需要显式开启），所以换钥匙不影响通知。

### 局域网地址是怎么挑的

自动选地址时会跳过 `169.254.x.x`（网卡没拿到租约时的临时地址，手机根本路由不到）和 Hyper-V / WSL / 蓝牙 / Wi-Fi Direct 这类虚拟网卡，优先真实的 Wi-Fi 或以太网地址。扫码后如果微信弹出「该地址为 IP 地址，请使用域名访问网站」，点「继续访问」即可。

## 一键启动与停止（Windows）

| 入口 | 用途 |
|---|---|
| `启动 AgentBridge.cmd` | 局域网模式：检查服务健康、避免重复占用 8787、后台启动并打开控制台 |
| `启动 AgentBridge 远程模式.cmd` | Tailscale 模式，跨网络使用 |
| `启动 AgentBridge ZeroTier 远程模式.cmd` | ZeroTier 模式，Tailscale 不稳定时使用 |
| `启动 AgentBridge Cloudflare 远程模式.cmd` | Cloudflare Tunnel，手机不需装任何 App（不做自动下载，缺 `cloudflared` 会直接报错并提示安装） |
| `安全停止 AgentBridge.cmd` | 安全停止：不误杀其它进程、有任务在跑时拒绝停止、绝不强制 kill |

这些脚本自己设置 `AGENTBRIDGE_PUBLIC_ORIGIN` 和访问密钥，和 CLI / 插件的自动模式**不要同时用**：同一端口只能有一个桥在跑，后启动的那个会连上已有实例而不是另起一个。

日志在 `<仓库>\.agentbridge\logs`；桌面快捷方式用 `.\scripts\install-agentbridge-shortcut.ps1` 创建或刷新。

## 让 Agent 支持 `/phone`

`/phone` 不是 Agent 自带的功能，而是 AgentBridge 往对应客户端里装的一个**技能**（一个 `SKILL.md` 文件）。它只做一件事：在**当前项目目录**里调用 `agentbridge phone --agent <id>`，由 CLI 确保 Bridge 在运行、准备公网地址、创建或附加会话、打印一次性二维码。

三个前提，每个 Agent 都一样：

1. Bridge 能在本机起来（上一步已自检）。
2. 目标 Agent 已安装并登录，且**在同一个项目目录里打开**。
3. 装完技能后**重启该客户端**，斜杠命令才会出现。

技能是纯文本文件，删掉对应的 `SKILL.md` 就等于卸载。

二维码默认是**公网地址**，三条路径共用同一套逻辑、同一条隧道、同一把访问密钥：`cloudflared` 缺了就自动下载；DSH 插件已经开着隧道时，CLI 直接复用它，不会再起一条。只想在局域网用就设 `AGENTBRIDGE_NO_TUNNEL=1`；已有自己的公网入口就设 `AGENTBRIDGE_PUBLIC_ORIGIN`。

> 一个例外：如果本机已经有一个**以局域网地址**运行的桥（比如很久以前启动的旧进程），CLI 不会擅自重启它——那会打断正在跑的会话——只会提示本次沿用那个地址。停掉它或重启 DSH Desktop 即可换成公网地址。

### Claude Code

```powershell
# 用户级（默认）：%USERPROFILE%\.claude\skills\phone\SKILL.md
agentbridge install-claude-skill --user

# 只装给某个项目：<项目>\.claude\skills\phone\SKILL.md
agentbridge install-claude-skill --project --cwd D:\projects\agentbridge
```

重启 Claude Code，在项目目录输入 `/phone`。技能用官方 `${CLAUDE_SESSION_ID}` 绑定**当前这段对话**，不读私有 transcript、不猜路径；只预授权 `agentbridge phone --agent claude …` 这一条命令，不授予通用 Bash 权限。

> 手机接管期间让原来的 Claude 终端保持空闲——Claude 官方说明多个进程写同一会话会交错消息。

### Codex Desktop

```powershell
# 用户级（默认）：%USERPROFILE%\.agents\skills\phone\SKILL.md
agentbridge install-codex-skill --user
```

重启 Codex 桌面项目，在本地项目会话输入 `/phone`。Codex 没对外提供「当前线程 ID」，所以不带参数时它会在同一项目目录**新建**一个会话并明确标注；只有你已知 thread ID 时才精确附加：

```powershell
agentbridge phone --agent codex --session <thread-id>
```

### DSH Desktop

前提：DSH Desktop 已安装，且存在桌面 profile `%USERPROFILE%\.dsh\profiles\desktop\package.json`（或由 `DSH_HOME` 指定）。

**第 0 步：桥。** 插件是遥控器，桥是基站。从 0.2.0 起桥随插件一起安装，**DSH Desktop 启动时插件会自己在后台把它拉起来**；从 0.3.0 起还会再自动开 Cloudflare 隧道。所以正常情况你什么都不用敲，重启桌面等几秒后直接 `/phone`。

只有自动启动失败（沙箱限制、端口被占）才需要手动来一条：

```powershell
npx @chenacc/agentbridge
```

**第 1 步：装插件（普通用户走市场）**：设置 → 插件市场 → 发现，搜 `AgentBridge` 或 `@chenacc/dsh-agentbridge` → 安装 → 重启 DSH Desktop。等价的手动安装：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"; pnpm add @chenacc/dsh-agentbridge@latest
# 装完还需把 "@chenacc/dsh-agentbridge" 加进该 package.json 的 dsh.profile.bundles（市场安装会自动做）
```

> 市场卡片上显示的版本号来自插件目录快照，每天刷新一次；实际安装拉的是 npm 的 `latest`，所以卡片版本可能比装到的版本旧一天。

**从本地源码装（开发者）**：

```powershell
npm run install:dsh-phone
```

这条命令只改 `%USERPROFILE%\.dsh`：把插件复制进 profile 的 `node_modules`、在 profile 的 `package.json` 里登记 `@chenacc/dsh-agentbridge` 并加入 `dsh.profile.bundles`，同时留一份 `package.json.agentbridge-backup`；**不会**改动 `DSH Desktop.exe` 或 `app.asar`。装完重启 DSH Desktop，在项目会话里输入 `/phone`。

> 两种装法别同时用：同一插件名同时存在于本地 `file:` 层和 npm 层时，重启后只有一个会生效。

这是唯一能**精确绑定屏幕上那条会话**的入口（会话 ID、目录、provider、模型都取自真实会话）。卸载：

```powershell
npm run uninstall:dsh-phone
```

发布到插件市场的完整流程见 [`docs/PUBLISHING.md`](./docs/PUBLISHING.md)。

### DeepSeek Harness（CLI / ACP）

前提：官方 `dsh` CLI 已安装并配置好模型与凭据，`dsh --profile acp --help` 能打印帮助（而不是弹出浏览器界面）。这个适配器没有斜杠技能，直接用 CLI：

```powershell
agentbridge phone --agent deepseek-harness
```

### 一张表汇总

| Agent | 前提 | 要执行的安装命令 | 重启客户端 | 入口 | 二维码默认地址 |
|---|---|---|---|---|---|
| Claude Code | 已安装并登录 | `agentbridge install-claude-skill --user` | 需要 | `/phone` | 公网 |
| Codex Desktop | 已安装并登录 | `agentbridge install-codex-skill --user` | 需要 | `/phone` | 公网 |
| DSH Desktop | 存在桌面 profile | 插件市场安装（或 `pnpm add`） | 需要 | `/phone` | 公网 |
| DeepSeek Harness | `dsh --profile acp --help` 可用 | 不需要 | — | `phone --agent deepseek-harness` | 公网 |
| Echo | 无 | 不需要 | — | `phone --agent echo` | 公网 |
| ZCode | 仅官方 Remote Control / Bot Channel | 不需要 | — | AgentBridge 不代管 | — |

### 通用说明

- `/phone` 只接受来自本机 loopback 的绝对路径，手机会话无法提交任意目录。
- 想让 `agentbridge` 成为全局命令，在仓库里跑一次 `npm link`。
- 想从固定版本装：`npm install --global github:chenacc1/agentbridge#bridge-v0.1.4`，然后 `agentbridge setup codex` 装技能。

## 支持的 Agent

| 适配器 | 状态 | 说明 |
|---|---|---|
| Echo | 可用 | 进程内回声，安全验证扫码、同步与断线重连 |
| OpenAI Codex | 安装后可用 | `codex app-server --stdio`；流式、取消、审批、提问、历史发现 |
| Claude Code | 安装后可用 | `claude --print --input-format stream-json`；恢复、取消、审批与提问 |
| DeepSeek Harness | 安装官方 dsh 后可用 | `dsh --profile acp` 的独立 ACP 会话 |
| DSH Desktop | 安装本地 bundle 后可用 | 绑定屏幕上的会话，可双向同步、切换模型、新建会话 |
| ZCode | 官方原生交接 | 走 ZCode Desktop 的 Remote Control / Bot Channel，本身不伪造会话接口 |

![分镜关键帧：多 Agent 适配层——统一控制台环绕四类可接入 Agent，ZCode 位于外圈并标为官方原生入口](./docs/assets/keyframe-06-agent-adapters.jpg)

每个适配器只承诺它真实支持的能力：缺哪项能力，界面就显示「未安装」或「仅桌面附着」，而不是摆一个按不动的按钮。

## 界面

![桌面端控制台](./docs/assets/screen-desktop-console.jpg)

手机端把同一份事件流重新排进窄屏：

| 手机端 ① | 手机端 ② |
|---|---|
| <img src="./docs/assets/screen-mobile-1.png" alt="手机端控制台 1" width="300" /> | <img src="./docs/assets/screen-mobile-2.png" alt="手机端控制台 2" width="300" /> |

## 常用配置

完整变量见 [`.env.example`](./.env.example)。

**桥本身：**

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTBRIDGE_PORT` | `8787` | HTTP 监听端口 |
| `AGENTBRIDGE_HOST` | `0.0.0.0` | 监听地址 |
| `AGENTBRIDGE_PROJECTS` | 当前目录 | 项目白名单，分号分隔 `别名=绝对路径` |
| `AGENTBRIDGE_DATA_DIR` | `~/.agentbridge`（CLI / 插件）/ 启动目录（`npm start`） | 会话、事件、密钥、隧道状态的目录 |
| `AGENTBRIDGE_PUBLIC_ORIGIN` | 自动（公网隧道或局域网地址） | 写进二维码的访问地址；设了它就不再自动开隧道 |
| `AGENTBRIDGE_ACCESS_KEY` | 未设置 | 访问密钥；对公网开放时自动生成并写入 `access-key` 文件 |
| `AGENTBRIDGE_PAIRING_TTL_MS` | `300000` | 配对码有效期（5 分钟） |
| `AGENTBRIDGE_SESSION_TTL_MS` | `259200000` | 设备会话有效期（72 小时） |
| `AGENTBRIDGE_CLAUDE_MODEL` | 供应商默认 | 可选的 Claude / Kimi 模型 ID |
| `AGENTBRIDGE_NOTIFY_WEBHOOK` | 未设置 | 通知 Webhook；未设置时该功能静默 |

**跨网络（CLI 与插件都认）：**

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTBRIDGE_REMOTE` | `auto` | 走哪条路径：`auto` / `cloudflare` / `named` / `funnel` / `tailscale` / `zerotier` / `lan` |
| `AGENTBRIDGE_NO_TUNNEL` | 未设置 | 设为 `1` 等价于 `AGENTBRIDGE_REMOTE=lan` |
| `AGENTBRIDGE_TUNNEL_URL` | 未设置 | 直接指定隧道域名（给"隧道自己管"的人） |
| `AGENTBRIDGE_CLOUDFLARE_TUNNEL` | 未设置 | Cloudflare **命名隧道**的名字；设了它 `auto` 会优先用它 |
| `AGENTBRIDGE_CLOUDFLARE_HOSTNAME` | 未设置 | 命名隧道对应的公网域名 |
| `AGENTBRIDGE_CLOUDFLARED` | 自动查找 | 用你自己那份 `cloudflared`；设了它既不搜索也不下载 |
| `AGENTBRIDGE_CLOUDFLARED_URL` | 官方 Releases | 换下载源（内网镜像），下载后照样过 `--version` 校验 |
| `AGENTBRIDGE_NO_DOWNLOAD` | 未设置 | 设为 `1` 禁止自动下载 `cloudflared` |
| `AGENTBRIDGE_TAILSCALE` | 自动查找 | 指定 `tailscale` 可执行文件（装在非常规位置时用） |
| `AGENTBRIDGE_ZEROTIER` | 自动检测网卡 | 直接指定 ZeroTier 分配到的 IPv4 |

**插件 / CLI 专用：**

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTBRIDGE_ORIGIN` | `http://127.0.0.1:8787` | 插件连接的本地桥地址 |
| `AGENTBRIDGE_LOCAL_ORIGIN` | `http://127.0.0.1:8787` | CLI 连接的本地桥地址 |
| `AGENTBRIDGE_NO_AUTOSTART` | 未设置 | 设为 `1` 关掉"插件加载时自动起桥" |

变量要设在**真正启动 DSH Desktop / 终端的环境里**，不是设在跑桥的另一个窗口里。

## 安全边界

![访问边界：本地配对与管理接口只允许 loopback；远程访问使用私有网络或受访问密钥保护的隧道。](./docs/assets/security-boundaries.svg)

- 二维码里是一次性配对码，不是 Agent 凭据；磁盘只保存设备 token 的 SHA-256 摘要。
- 设备 cookie 为 `HttpOnly` + `SameSite=Strict`；修改型请求校验同源，命令 ID 防重放，同一会话同时只有一台设备持有输入租约。
- 对公网开放时访问密钥强制开启，非 loopback 请求一律要求带密钥；密钥不写进命令行、不进日志。
- 桥的本地管理接口（配对、注册、停止、`cloudflared` 状态）只接受 loopback；即便是同一台机器上的"要求桥重启"这类动作，也要带上插件在启动时生成的一次性 token。
- Agent 凭据与子进程始终留在电脑上，手机永远不是执行环境。
- 当前不提供多用户授权、静态加密事件日志、重启后活动子进程恢复或云端 Relay。

> 默认公网可用意味着**二维码等同于钥匙**：别截图外传，也别把带 `?key=` 的链接贴到公开场合。只想在家里用时设 `AGENTBRIDGE_NO_TUNNEL=1`。

## 验证

```powershell
npm run check           # 语法检查（38 个文件）
npm test                # 单元与集成测试（当前 240 项全部通过）
npm run verify:release  # 插件发布验收（17 项：registry / tarball / 可导入性）
npm run verify:remote   # 端到端验证 Cloudflare 远程链路，需要 cloudflared 与网络
npm run verify:mobile   # 可选：真实浏览器端到端，需要 Chrome 或 Edge
```

其余 `verify:*` 脚本（`navigation`、`models`、`scrim`、`notify`、`attach`、`features`、`blocks`、`questions`、`quicknav`、`responsive`、`guide`）各自启动真实 Bridge 与无头浏览器做界面验证。

## 版本与发布

两个 npm 包，各自独立发版，都由 GitHub Actions 用 tag 触发（OIDC 可信发布，带 SLSA provenance）：

| 包 | 当前版本 | tag 前缀 | 装到哪 |
|---|---|---|---|
| `@chenacc/agentbridge` | `0.2.0` | `bridge-v*` | 全局命令 / `npx` / 插件依赖 |
| `@chenacc/dsh-agentbridge` | `0.4.0` | `dsh-v*` | DSH Desktop 的 profile |

最近的阶段性变化：

- **0.2.0（桥）**：路径选择抽成 provider（`src/remote.js`）——Cloudflare quick / 命名隧道 / Tailscale / Tailscale Funnel / ZeroTier 共用一套顺序与回退，`AGENTBRIDGE_REMOTE` 可指定单条；`/api/health` 与启动日志会报出当前走的是哪条。
- **0.1.1–0.1.4（桥）**：二维码地址改按"能不能被手机路由到"排序（跳过 `169.254` 与虚拟网卡）；`/api/health` 汇报自己广播的地址；新增只有本机 token 能调的自动重启入口；隧道能力下沉到本包，CLI 的 `/phone` 因此也默认公网。
- **0.4.0（插件）**：改用桥包里的同一套路径选择，本地行为不变但多了 Funnel / Tailscale / ZeroTier 三条可选路径。
- **0.3.0–0.3.3（插件）**：加载时自动起桥、自动开 Cloudflare 隧道、`cloudflared` 缺失时自动下载。

升级方式：

```powershell
npm install -g @chenacc/agentbridge@latest            # CLI / 桥
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add @chenacc/dsh-agentbridge@latest              # DSH 插件（或直接在插件市场点安装）
```

## 更多文档

- 架构说明：[`docs/architecture/wechat-multi-agent-remote-control.md`](./docs/architecture/wechat-multi-agent-remote-control.md)
- 功能与前端执行逻辑：[`docs/软件功能与前端执行逻辑.md`](./docs/软件功能与前端执行逻辑.md)
- 发布流程：[`docs/PUBLISHING.md`](./docs/PUBLISHING.md)
- 安装验收清单：[`docs/verify-plugin-install.md`](./docs/verify-plugin-install.md)
- 市场收录记录：[`docs/market-submission.md`](./docs/market-submission.md)
- 版本与更新记录：[`docs/RELEASING.md`](./docs/RELEASING.md)
