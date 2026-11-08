# 20 秒演示 GIF：怎么录、放哪儿

README 和 npm 首页最需要的东西不是更多文字，而是一段能在 20 秒里看完“手机真的能控制这台电脑”的动图。这个文件说明怎么把它录出来——录制这件事我没法代劳，因为它需要真实的桌面窗口和一台手机。

## 录之前准备

```powershell
# 1. 让桥和隧道都起来（顺便确认公网地址可用）
npx @chenacc/agentbridge phone --agent echo

# 2. 打开桌面控制台
Start-Process "http://127.0.0.1:8787"
```

手机先扫码配对一次（用 `echo` 适配器即可，不需要真的跑 Claude 或 Codex），这样录制时手机端已经有历史记录，画面不空。

## 录制脚本（建议按这个顺序，一气呵成）

| 秒 | 画面 | 要点 |
|---|---|---|
| 0–3 | 桌面控制台，鼠标停在输入框 | 让人先看清“这是一条真实的会话” |
| 3–6 | 切到手机，微信扫一下 `/phone` 输出的二维码 | 只出现一次的画面，别剪掉 |
| 6–12 | 手机输入「帮我看下这个报错」并发送 | 输入法弹出再收起，节奏自然 |
| 12–18 | 桌面端同一句话逐字出现，Agent 开始回复；再切回手机看流式输出 | **这一段是核心卖点**：两端同一份事件流 |
| 18–20 | 手机上点一次「允许」审批，桌面继续 | 结尾给一个“能干活”的动作，而不是只有聊天 |

Windows 自带 Xbox Game Bar（`Win + G`）就能录屏；要好一点用 [OBS](https://obsproject.com/) 录 1080p 30fps。手机端用系统自带录屏。

## 剪辑与体积

- 剪到 **20 秒以内**，只留上面五段；
- 导出 GIF：`ffmpeg` 一行就够，注意控制体积（GitHub 在 README 里显示超过 ~10 MB 的 GIF 会很慢）：

  ```powershell
  ffmpeg -i demo.mp4 -vf "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 demo.gif
  ```

- 目标 **≤ 4 MB**。超了就降 `fps`（12 → 10）或宽度（720 → 600）；
- 放两处：

  ```text
  docs/assets/demo-phone.gif     ← README 用
  integrations/dsh-phone/assets/demo-phone.gif   ← npm 插件页用（记得加进 package.json 的 files）
  ```

## 换成 README 里的图

README 顶部现在是一张三图并排（`screen-desktop-console.jpg` + 两张 `screen-mobile-*.png`）。录好之后把那一整块表格换成：

```markdown
![20 秒演示：桌面端生成二维码，手机扫码后接管同一条会话](./docs/assets/demo-phone.gif)
```

三张静态图可以留在下面「界面」一节，作为细节展示。

## 为什么值得花这半小时

README 的第一屏决定了“点不点安装”。现在首屏是图标 + 一句话 + 一条命令 + 三张截图，已经能看懂；但一段动图能省掉读者全部的想象成本——尤其这件事的价值只有动起来才看得出来（扫码 → 两端同步）。
