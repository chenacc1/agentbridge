# @chenacc/dsh-agentbridge

AgentBridge 的 DSH Desktop 集成插件。在某个项目会话里执行 `/phone`，把**屏幕上那一条** live Agent 会话接到手机控制台：手机扫码后可以发消息、审批、切换模型、停止任务，桌面与手机看到同一份事件流。

- 精确绑定当前会话：会话 ID、项目目录、provider / 模型都取自真实会话，不是新建一个"类似的"会话。
- 电脑始终是唯一执行端：凭据和文件访问留在本机，手机只下发命令。

## 前置条件（重要）

这个插件**只是一个桥接层**，它自己不是服务端。它需要本机运行 AgentBridge 主程序（默认 `http://127.0.0.1:8787`）：

```powershell
git clone https://github.com/chenacc1/agentbridge.git
cd agentbridge
npm install
npm start          # 或双击仓库里的「启动 AgentBridge.cmd」
```

没有这一步，`/phone` 会返回"无法连接 AgentBridge"，插件不会自己下载或启动任何服务。

要求：DSH Desktop 已安装（存在 `%USERPROFILE%\.dsh\profiles\desktop\package.json`），Node.js 22+。

## 安装

通过 DSH Desktop 的插件市场安装，或手动装进当前 profile：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add @chenacc/dsh-agentbridge@latest
```

然后确认 profile 的 `package.json` 里有：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@chenacc/dsh-agentbridge"] } }
}
```

改完重启 DSH Desktop 才会加载命令。

## 使用

1. 确保 AgentBridge 已经在跑（见上方前置条件），手机与电脑在同一可信 Wi-Fi 或已配好远程通道。
2. 在 DSH Desktop 里打开目标项目会话，输入 `/phone`。
3. 终端里出现一次性二维码（5 分钟有效、只能用一次）。用微信扫一扫，进入手机控制台。
4. 配对成功后收藏手机页显示的固定回访地址，之后从收藏进入，不要再扫。

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTBRIDGE_ORIGIN` | `http://127.0.0.1:8787` | 插件连接的 AgentBridge 地址；桥换了端口或走了隧道时设置它 |

变量要设在**真正启动 DSH Desktop 的环境里**（插件读 `process.env`），不是设在跑 bridge 的终端里。

## 卸载

在插件市场里卸载，或：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove @chenacc/dsh-agentbridge
```

并把 `dsh.profile.bundles` 里的 `@chenacc/dsh-agentbridge` 删掉，然后重启 DSH Desktop。

## 兼容性

| 版本 | 需要 |
|---|---|
| 插件 0.1.x | DSH Desktop（`@deepseek-ai/dsh-commands`、`@deepseek-ai/cordis` 由 DSH 提供）、AgentBridge `0.1.x` |

插件与 bridge 之间有一份集成版本号握手：bridge 侧要求的最低集成版本比插件旧时，手机端会提示"桌面端集成是旧版"，升级插件即可。

## 许可证

MIT
