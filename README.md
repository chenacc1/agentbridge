# AgentBridge

> 用微信扫一扫打开手机控制台，安全地查看、继续或停止这台电脑上正在运行的编程 Agent——不用把电脑暴露到公网，凭据始终留在本机。

![AgentBridge 架构：电脑上的本地 Bridge 连接已配对手机，并调用获准的编程 Agent 适配器。](./docs/assets/architecture.svg)

手机与桌面共享同一份可追加事件流，因此消息、工具活动、审批和任务状态始终同步。电脑是唯一的执行端：手机只下发命令，不运行 Agent，也拿不到任何供应商凭据。

## 主要能力

- **扫码配对**：一次性、5 分钟有效的二维码；配对后收藏固定回访地址，之后免扫码进入。
- **工作区 → 会话导航**：一个抽屉管理「Agent → 项目 → 会话」，Bridge 重启后历史与会话不丢失。
- **完整对话控制**：流式输出、停止、接管输入、翻看历史，表格 / 公式 / 代码块正确渲染。
- **远程协作**：审批卡片、提问卡片、限时自动放行（5/10/30 分钟）、消息排队、会话内搜索。
- **手机输入**：上传图片与文件、语音转文字、一键复制命令。
- **模型切换**：只使用 Agent 真实上报的模型目录，绝不编造模型名。
- **通知推送**：需要你处理时推送到企业微信 / Telegram / ServerChan / PushPlus。
- **多 Agent 统一接入**：Codex、Claude Code、DeepSeek Harness、DSH Desktop、ZCode（官方跳转）。

## 一分钟上手

![从本机启动到手机控制的四步流程。](./docs/assets/phone-flow.svg)

前提：Node.js 22 或更高。Codex / Claude Code / DeepSeek Harness 都是可选项，AgentBridge 会自动检测本机已安装并已登录的工具。

```powershell
npm install
$env:AGENTBRIDGE_PROJECTS = "agentbridge=D:\projects\agentbridge"
npm start
```

在电脑上打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，桌面页会显示一次性二维码；手机连同一可信 Wi-Fi，用微信「扫一扫」扫描即可。

> 二维码只用于首次配对，会过期且只能用一次。配对成功后请收藏手机页显示的固定回访地址，不要收藏 `/pair?code=...` 临时链接。

## 一键启动与停止（Windows）

| 入口 | 用途 |
|---|---|
| `启动 AgentBridge.cmd` | 局域网模式：检查服务健康、避免重复占用 8787、后台启动并打开控制台 |
| `启动 AgentBridge 远程模式.cmd` | Tailscale 模式，跨网络使用 |
| `启动 AgentBridge ZeroTier 远程模式.cmd` | ZeroTier 模式，Tailscale 不稳定时使用 |
| `启动 AgentBridge Cloudflare 远程模式.cmd` | Cloudflare Tunnel，手机不需装任何 App |
| `安全停止 AgentBridge.cmd` | 安全停止：不误杀其它进程、有任务在跑时拒绝停止、绝不强制 kill |

日志在 `.agentbridge/logs`；桌面快捷方式用 `.\scripts\install-agentbridge-shortcut.ps1` 创建或刷新。

## 远程接入方式

| 场景 | 模式 | 手机要求 |
|---|---|---|
| 同一可信 Wi-Fi | 局域网 | 浏览器 / 微信 |
| 跨网络，但属同一私有网络 | Tailscale | 同一 tailnet |
| Tailscale 不稳定 | ZeroTier | 同一私有网络 |
| 手机装不了 VPN 类 App | Cloudflare Tunnel | 只需浏览器 |

![访问边界：本地配对与管理接口只允许 loopback；远程访问使用私有网络或受访问密钥保护的隧道。](./docs/assets/security-boundaries.svg)

任何模式都不要把 TCP 8787 直接映射到公网。Cloudflare 模式额外启用访问密钥闸门（密钥存于 `.agentbridge/access-key`），光有二维码不够。

## 用 `/phone` 绑定当前会话

| Agent | 安装技能（一次） | 使用 |
|---|---|---|
| Claude Code | `node .\bin\agentbridge.js install-claude-skill --user` | 在该项目目录执行 `/phone` |
| Codex Desktop | `node .\bin\agentbridge.js install-codex-skill --user` | 在本地项目会话执行 `/phone`，已知 thread ID 时加 `--session` |
| DSH Desktop | `npm run install:dsh-phone` | 在桌面会话执行 `/phone`，精确绑定屏幕上的那条会话 |

通用命令行：

```powershell
node .\bin\agentbridge.js phone --agent echo               # 不碰 AI 工具，安全验证整条链路
node .\bin\agentbridge.js phone --agent codex              # 当前目录新建 Codex 会话
node .\bin\agentbridge.js phone --agent deepseek-harness
```

`/phone` 只接受来自本机 loopback 的绝对路径，手机端无法提交任意目录。仓库目前尚未创建 `v0.1.0` 标签；打上固定标签后，其他人可用 `npm install --global github:chenacc1/agentbridge#v0.1.0; agentbridge setup codex` 一行安装 CLI 与技能。

## 支持的 Agent

| 适配器 | 状态 | 说明 |
|---|---|---|
| Echo | 可用 | 进程内回声，安全验证扫码、同步与断线重连 |
| OpenAI Codex | 安装后可用 | `codex app-server --stdio`；流式、取消、审批、提问、历史发现 |
| Claude Code | 安装后可用 | `claude --print --input-format stream-json`；恢复、取消、审批与提问 |
| DeepSeek Harness | 安装官方 dsh 后可用 | `dsh --profile acp` 的独立 ACP 会话 |
| DSH Desktop | 安装本地 bundle 后可用 | 绑定屏幕上的会话，可双向同步、切换模型、新建会话 |
| ZCode | 官方原生交接 | 走 ZCode Desktop 的 Remote Control / Bot Channel，本身不伪造会话接口 |

## 界面

![桌面控制台（公开截图中已移除配对区与设备管理区）](./docs/assets/ui-desktop.png)

<p align="center"><img src="./docs/assets/ui-mobile.png" alt="手机控制台" width="360" /></p>

## 常用配置

完整变量见 [`.env.example`](./.env.example)。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTBRIDGE_PORT` | `8787` | HTTP 监听端口 |
| `AGENTBRIDGE_PROJECTS` | 当前目录 | 项目白名单，分号分隔 `别名=绝对路径` |
| `AGENTBRIDGE_PUBLIC_ORIGIN` | 第一个 LAN 地址 | 写入二维码的访问地址 |
| `AGENTBRIDGE_PAIRING_TTL_MS` | `300000` | 配对码有效期（5 分钟） |
| `AGENTBRIDGE_SESSION_TTL_MS` | `259200000` | 设备会话有效期（72 小时） |
| `AGENTBRIDGE_CLAUDE_MODEL` | 供应商默认 | 可选的 Claude / Kimi 模型 ID |
| `AGENTBRIDGE_NOTIFY_WEBHOOK` | 未设置 | 通知 Webhook；未设置时该功能静默 |

若自动选择的局域网地址手机访问不到，显式指定 `AGENTBRIDGE_PUBLIC_ORIGIN`；Windows 防火墙提示时只放行「专用网络」。

## 安全边界

- 二维码里是一次性配对码，不是 Agent 凭据；磁盘只保存设备 token 的 SHA-256 摘要。
- 设备 cookie 为 `HttpOnly` + `SameSite=Strict`；修改型请求校验同源，命令 ID 防重放，同一会话同时只有一台设备持有输入租约。
- Agent 凭据与子进程始终留在电脑上，手机永远不是执行环境。
- 当前不提供多用户授权、静态加密事件日志、重启后活动子进程恢复或云端 Relay。

## 验证

```powershell
npm run check           # 语法检查
npm test                # 单元与集成测试（当前 187 项全部通过）
npm run verify:mobile   # 可选：真实浏览器端到端，需要 Chrome 或 Edge
```

其余 `verify:*` 脚本（`navigation`、`models`、`scrim`、`notify`、`attach`、`features`、`blocks`、`questions`、`quicknav`）各自启动真实 Bridge 与无头浏览器做界面验证。

## 更多文档

- 架构说明：[`docs/architecture/wechat-multi-agent-remote-control.md`](./docs/architecture/wechat-multi-agent-remote-control.md)
- 功能与前端执行逻辑：[`docs/软件功能与前端执行逻辑.md`](./docs/软件功能与前端执行逻辑.md)
- 发布流程：[`docs/RELEASING.md`](./docs/RELEASING.md)
