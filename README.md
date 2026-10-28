# AgentBridge MVP

AgentBridge lets a phone opened from WeChat's scanner control coding agents running on this computer. The desktop and phone use the same append-only event stream, so messages, tool activity, approvals, and task state stay in sync.

This repository is a working local-first MVP. It includes:

- a one-time, two-minute QR pairing flow, plus a fixed non-secret return address the phone can favourite;
- a responsive mobile/desktop web console navigated as Agent → project → conversation;
- durable Workspace and conversation catalogs, so a bridge restart no longer loses history;
- HTTP commands plus resumable Server-Sent Events;
- project allowlisting, per-device sessions, command idempotency, and control leases;
- an Echo adapter for safe end-to-end testing;
- real OpenAI Codex App Server and Claude Code CLI adapters;
- a real DeepSeek Harness ACP adapter and a truthful ZCode native-remote handoff;
- a DSH Desktop `/phone` bundle that binds the exact open Desktop conversation;
- attachments, in-conversation search, message queueing, model switching, and time-boxed auto-approval from the phone;
- push notifications to WeCom, Telegram, ServerChan, or PushPlus when an agent needs you.

## Install `/phone` from a GitHub release

After this repository has been pushed to GitHub and tagged (for example `v0.1.0`), a Codex user with Node.js 22+ can install AgentBridge and its user-wide `/phone` skill in one terminal line:

```powershell
npm install --global github:<github-owner>/<repository>#v0.1.0; agentbridge setup codex
```

Replace the placeholders with the public GitHub owner and repository. The command installs the durable `agentbridge` CLI, then writes the Codex skill to the user's `.agents/skills/phone/SKILL.md`. Restart Codex after installation; `/phone` then starts AgentBridge when necessary and produces a one-time QR code for the current project.

For Bash or zsh, replace `;` with `&&`. A fixed tag is intentional: it makes the installed code reviewable and reproducible. See [`docs/RELEASING.md`](./docs/RELEASING.md) before creating the first release.

## Quick start

Requirements: Node.js 22 or newer. Codex, Claude Code, and DeepSeek Harness are optional; AgentBridge detects the supported local tools that are installed and authenticated on the computer.

```powershell
npm install
$env:AGENTBRIDGE_PROJECTS = "agentbridge=D:\projects\agentbridge"
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787) on the computer. The desktop page creates its own local session and shows a one-time QR code. Keep the phone and computer on the same trusted LAN, open WeChat's **扫一扫**, and scan the code.

### Windows one-click start

Double-click `启动 AgentBridge.cmd` in the project root. It checks whether AgentBridge is already healthy, prevents a second copy from binding port 8787, starts the service in the background, writes logs under `.agentbridge/logs`, and opens the desktop page. If port 8787 is occupied by an unhealthy process, the window stays open and shows the conflicting process instead of starting another copy.

You may also create a normal Windows desktop shortcut pointing to this `.cmd` file. After AgentBridge is healthy, `/phone` in Claude Code or Codex can generate a QR code without keeping a terminal window open.

To create or refresh the desktop shortcut automatically, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-agentbridge-shortcut.ps1
```

This creates `AgentBridge.lnk` on the current user's desktop. The shortcut starts the same guarded launcher and opens the local dashboard.

### Windows one-click stop

Double-click `安全停止 AgentBridge.cmd` in the project root, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-agentbridge.ps1
```

It asks the running bridge to stop over the loopback-only `POST /api/local/shutdown` and waits for port 8787 to be released. Three things make it safe rather than merely convenient:

- it refuses to touch a port-8787 listener whose owning process is not this repository's `node src/server.js`, so an unrelated process is never killed;
- if a turn is still running the bridge answers `409 ACTIVE_SESSIONS`, the script lists those sessions and exits without stopping anything — end them in the console first;
- if the port is not released before the deadline it reports that instead of force-killing the process.

`-Port` and `-WaitSeconds` override the defaults. Only the bridge is stopped: Cloudflare, Tailscale, and ZeroTier processes keep running.

### Tailscale one-click remote mode

Use this mode when the phone and computer are not on the same Wi-Fi. Install Tailscale on both devices, sign in to the same tailnet, and keep both devices connected. Then refresh the desktop shortcuts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-agentbridge-shortcut.ps1
```

Double-click **AgentBridge Remote** on the Windows desktop, or run `启动 AgentBridge 远程模式.cmd` from this repository. The launcher:

1. checks that Tailscale is installed, signed in, and online;
2. reads this computer's stable `100.64.0.0/10` Tailscale IPv4 address;
3. safely restarts only a port-8787 process verified as this repository's AgentBridge;
4. listens on `0.0.0.0` while encoding `http://100.x.y.z:8787` into new `/phone` QR codes;
5. opens the local dashboard and keeps logs under `.agentbridge/logs`.

Now run `/phone` in the desired Codex, Claude Code, or DSH Desktop project conversation and scan the new QR. The phone may use cellular data or another Wi-Fi, but the Tailscale app must remain connected to the same tailnet. No router port forwarding or public IP is required.

This implementation deliberately uses the direct tailnet IP instead of Tailscale Serve or Funnel. AgentBridge's local setup endpoints distinguish loopback requests from remote requests; placing the current server behind a localhost reverse proxy would weaken that boundary. Funnel would also publish the service to the public Internet, which is outside this personal private-network mode.

If the shortcut reports that Tailscale is offline, open the Tailscale tray app and sign in. Useful checks are:

```powershell
tailscale status
tailscale ip -4
```

On some Windows installations, a normal user receives `Access is denied` from the Tailscale CLI even though its service is running. You then have two choices: run **AgentBridge Remote** as Administrator whenever needed, or, after reviewing the permission, run this once in an Administrator PowerShell:

```powershell
tailscale set --operator="$env:USERNAME"
```

The operator setting persistently allows that Windows account to control the local Tailscale service, so AgentBridge does not apply it silently. It does not grant access to other tailnets, but it is still a local privilege change and should be enabled only for your own trusted Windows account.

If the phone cannot connect, confirm it can open the shown `http://100.x.y.z:8787` address while Tailscale is connected. Windows Firewall should allow Node.js on the Tailscale/private network; do not expose TCP 8787 through the router.

### ZeroTier one-click remote mode (works where Tailscale is unreliable)

ZeroTier is an alternative encrypted overlay network with the same security model as the Tailscale mode: the service stays inside the private virtual network, nothing is exposed to the public Internet, and AgentBridge's loopback-only setup endpoints remain unreachable from the phone path. It tends to be more reliable on networks where Tailscale's coordination servers are hard to reach, and it has official iOS and Android apps.

Setup, once:

1. Create a free account at [my.zerotier.com](https://my.zerotier.com) and create a network (keep **Private** access control). Copy its 16-hex-digit network ID.
2. Install **ZeroTier One** on this PC and join the network ID. Install the **ZeroTier** app on the phone and join the same network ID.
3. In my.zerotier.com → Members, tick **Auth** for both devices so they receive their managed IP addresses.

Then refresh the desktop shortcuts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-agentbridge-shortcut.ps1
```

Double-click **AgentBridge Remote ZeroTier** on the Windows desktop, or run `启动 AgentBridge ZeroTier 远程模式.cmd` from this repository. The launcher mirrors the Tailscale mode — it verifies the ZeroTier adapter is up and has a managed IPv4 address (read via WMI, so no Administrator rights or CLI token are needed), safely restarts a verified AgentBridge on port 8787, listens on `0.0.0.0`, and encodes `http://<zerotier-ip>:8787` into new `/phone` QR codes.

The phone may use cellular data or any Wi-Fi; only the ZeroTier app must stay connected. If the phone cannot pair, allow Node.js through Windows Firewall when prompted (the ZeroTier adapter may be classified as a public network), and confirm the phone can open the shown `http://<zerotier-ip>:8787` address. Do not expose TCP 8787 through the router.

If ZeroTier's root servers are also unreliable for you, self-hosting a ZeroTier **moon** relay on a small VPS keeps the same mode working unchanged — both devices simply orbit the moon.

### Cloudflare Tunnel mode (no app on the phone at all)

Use this when VPN-style apps are unavailable on the phone (for example, ZeroTier/Tailscale are not in the Chinese App Store). `cloudflared` runs on the PC and publishes AgentBridge behind a free `https://<random>.trycloudflare.com` URL — the phone only needs a browser, on any network.

Install cloudflared once:

```powershell
winget install --id Cloudflare.cloudflared
```

Then double-click **AgentBridge Remote Cloudflare** on the Windows desktop (run `install-agentbridge-shortcut.ps1` first) or run `启动 AgentBridge Cloudflare 远程模式.cmd`. The launcher:

1. starts (or reuses a running) `cloudflared` quick tunnel and learns its assigned `trycloudflare.com` URL;
2. **forwards the tunnel to this PC's LAN IPv4 address, never `127.0.0.1`** — this keeps AgentBridge's loopback-only setup endpoints (pairing QR, `/api/bootstrap`, local sessions) unreachable through the public URL;
3. restarts a verified AgentBridge with the tunnel URL encoded into new `/phone` QR codes.

The quick-tunnel URL is public HTTPS but stays unguessable, and pairing still requires the one-time code displayed on the desktop. In this mode the launcher additionally enables a **shared access-key gate**: it generates a random key once (stored in `.agentbridge/access-key`, reused across restarts), embeds it in pairing and return QR codes, and every non-loopback request must carry it — a leaked URL alone is not enough to reach the pairing exchange. The key is printed in the launcher window for manual entry if a phone ever loses its cookie. The URL remains valid while the `cloudflared` process runs; rerun the launcher if it stops. If the LAN address changes (DHCP), restart the launcher so the tunnel target is refreshed.

Two more protections apply in every mode: paired-device sessions are persisted as SHA-256 digests in `.agentbridge/sessions.json`, so phones stay paired across bridge restarts; and the desktop page lists all paired devices under **已配对设备**, where any device (e.g. a lost phone) can be revoked with one click.

For a stable URL and an extra login gate, create a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with your own domain and optionally put Cloudflare Access in front of it, then start with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-agentbridge.ps1 -CloudflareTunnel -CloudflareNamedTunnel <name> -CloudflareOrigin https://bridge.example.com
```

Start with the Echo adapter. It verifies pairing, bidirectional commands, streaming, reconnect replay, and desktop/mobile synchronization without giving an AI tool access to files.

## Open the current project and conversation with `/phone`

Claude Code can expose the conversation that is already open in the current terminal. Install the local skill once:

```powershell
node .\bin\agentbridge.js install-claude-skill --user
```

Restart Claude Code so it discovers the skill. Then, from any project:

```text
cd D:\work\my-project
claude
> /phone
```

`/phone` passes Claude Code's official `${CLAUDE_SESSION_ID}` and the terminal's current directory to the loopback-only AgentBridge launcher. The CLI starts AgentBridge if necessary and prints a one-time QR code. Scanning it with WeChat opens that exact Bridge session, already selects it, and gives the phone the input lease. It does not guess the project from a message or inspect Claude's transcript.

The installed skill pre-approves only this exact AgentBridge launcher prefix through `allowed-tools`; it does not grant general Bash access. If Claude Code was already open while the skill was installed or upgraded, exit and reopen that Claude Code session before using `/phone`.

## Return to AgentBridge after closing WeChat

The QR emitted by `/phone` is intentionally short-lived and single-use. It is for first-time pairing only, so do **not** save that QR or its `/pair?code=...` URL.

After the first successful scan, AgentBridge displays a fixed return address in the phone UI. In WeChat, use the top-right `…` menu to **Favourite/收藏本页** (or copy the address). Reopening that favourite returns to the same Bridge and automatically selects the most recently used conversation for that paired phone. The desktop pairing strip also shows a separate “手机常用入口” QR; this QR contains only the fixed root address, never a pairing secret.

This shortcut works while AgentBridge is running and the WeChat site data/device session has not expired. If the cookie expires, WeChat site data is cleared, the Bridge is restarted, or a different phone scans the fixed QR, AgentBridge correctly asks for a fresh one-time scan instead of granting access.

Claude resumes the official session in a second CLI process. Keep the original Claude terminal idle while sending from the phone: Claude documents that concurrent processes writing to one session can interleave messages. AgentBridge prevents two paired phones from owning its input lease, but it cannot lock the original Claude terminal.

For Codex, Echo, or a known provider session ID, use the general CLI entry point:

```powershell
# Safe end-to-end test in the current directory
node .\bin\agentbridge.js phone --agent echo

# Start a new Codex conversation in the current directory
node .\bin\agentbridge.js phone --agent codex

# Attach a known, already-persisted Codex thread
node .\bin\agentbridge.js phone --agent codex --session <thread-id>
```

#### Codex Desktop `/phone`

Install the local Codex skill once:

```powershell
node .\bin\agentbridge.js install-codex-skill --user
```

Restart the Codex desktop project, then type `/phone` in a local-project conversation. The skill runs the loopback-only launcher with that project's current directory and prints a five-minute, single-use WeChat QR code. If Codex exposes a persisted thread ID to the invocation, use `--session <thread-id>` to attach exactly that conversation; the public skill interface does not expose an automatic current-thread ID substitution, so `/phone` without one creates a clearly labelled new Codex conversation in the same project. It never guesses the most recent desktop conversation.

After scanning, the phone page can select only models and reasoning efforts returned by the local Codex App Server for the signed-in account. The choice is applied to later phone turns in this AgentBridge session; it does not modify your global Codex settings or invent unavailable models.

AgentBridge can also discover persisted Codex threads for one registered workspace through the public App Server `thread/list` method. Discovery uses the workspace's exact canonical `cwd`, reads every cursor page, and merges results into the local Bridge session catalog without resuming them. It does not identify or guess which thread is currently visible in Codex Desktop; choose a listed thread, supply a known thread ID to `/phone`, or create a new conversation.

The authenticated catalog API is `GET /api/conversations?workspaceId=<workspace-id>&adapterId=codex`. It reads only the local catalog by default. Add `&refresh=1` for an explicit Provider refresh; protocol mismatches return a degraded diagnostic instead of falling back to private transcript files.

On a phone the top bar is a single 44px row — brand (truncating) and connection state side by side — while the drawer toggle is a 44×44 button fixed to the top-left corner with `env(safe-area-inset-*)`, so the Agent/project switcher stays reachable at any scroll position and fades out while the drawer is open. Below 360px the brand text and the connection label collapse to the mark and the dot instead of wrapping. The return strip is one compact line whose details expand on demand and are remembered. The console navigates through one drawer, ordered **Agent → project → conversation**. It is an overlay on a phone (☰ in the top bar) and a permanent 320px sidebar on a wide window, so the same tree serves both without a second navigation UI. An Agent that only has one project skips the project row, so reaching any conversation is two taps; a multi-project Agent gets the project layer because that is what splits it. Agents are ordered by their most recent conversation, uninstalled ones last, and each row carries what it can actually do (`可新建` / `仅桌面附着` / `未安装`) instead of hiding the tools that cannot be used. Expansion is remembered per Agent, and typing in the search box expands whatever it matched.

Creating a conversation moved to the drawer header: ＋ opens a bottom sheet that lists every Agent with its real capability, preselects the first one that can create, and blocks submission for attach-only or native hand-off entries with the reason. “刷新状态” re-reads the catalog; “同步历史” appears only when an installed Agent can publish its conversation list, and it opens a sheet that asks which Agent reads which project instead of guessing. It never starts a conversation and only registers what that Agent can publicly list. A conversation longer than one page keeps its older entries one tap away through the 加载更早 control, which pages backwards by `seq` and holds the reading position while the earlier page is inserted above. The same navigation is used in direct, ZeroTier, and Cloudflare remote modes because those modes change only how the phone reaches AgentBridge, not the local Workspace/session catalog.

You can optionally run `npm link` once and shorten these commands to `agentbridge phone ...`. The installed Codex skill is the convenient project-directory entry point; the CLI remains the reliable path when you already know the exact Codex thread ID to resume.

When a Codex turn stops to ask something, the phone shows it as a card. Codex sends that as an experimental `item/tool/requestUserInput` server request; AgentBridge renders its questions and options and answers with `{ answers: { <question id>: { answers: [<label>] } } }`. Skipping such a question is answered as a JSON-RPC error so Codex continues instead of waiting. Earlier releases replied `-32601` to that method, which is why the phone showed nothing and the run appeared stuck. Approval prompts were already supported and are unchanged.

### Which model does it use?

Codex and Claude keep the provider conversation's own model configuration by default. For a Codex phone session, AgentBridge requests `model/list` from the local App Server and shows only that account's picker-visible models plus the supported reasoning strengths; a selected pair is sent as `model` and `effort` on later turns. Set `AGENTBRIDGE_CLAUDE_MODEL` before starting AgentBridge only when you need an explicit Claude Code model override. For Kimi Code, use an API model ID such as `kimi-for-coding`, not the display/version name `kimi-k2.7-code`. A Claude process that produces no structured output within 30 seconds is stopped with a visible error instead of leaving the phone page waiting indefinitely.

### Claude Code questions and approvals

Claude Code asks a human over its **control stream**. AgentBridge therefore runs it with `--input-format stream-json` (the prompt goes in on stdin) and `--permission-prompts host`, and answers `can_use_tool` control requests from the phone:

- `AskUserQuestion` becomes a phone question card. Claude keys its answers by the question text, so the card's option labels are returned as `answers[<question text>]`, comma-joined for multi-select, with free text in `response`.
- Every other tool that needs a decision becomes a phone approval card: **仅本次批准** replies `{behavior:"allow"}`, **拒绝** replies `{behavior:"deny"}`.
- A control request the bridge does not understand is refused explicitly, because leaving it unanswered would park the turn.
- A prompt nobody answers is denied after `AGENTBRIDGE_CLAUDE_INTERACTION_TIMEOUT_MS` (default 5 minutes) and the turn continues, with **超时未答，已自动拒绝** recorded on the phone. Without that guard a lost phone would reproduce the original symptom: a run that silently never continues.

`--permission-prompts none` — the previous setting — made Claude Code delete `AskUserQuestion` and auto-deny every prompt, so the phone could never see one. It is no longer used.

To expose more projects, set aliases before starting the server:

```powershell
$env:AGENTBRIDGE_PROJECTS = "web=D:\work\web-app;api=D:\work\api"
npm start
```

The phone sends only an alias such as `web`; the server resolves it to an allowlisted absolute path. It cannot submit an arbitrary working directory.

The `/phone` launcher is the only exception: it accepts an absolute current directory exclusively from a loopback connection on this computer, confirms that the path is an existing directory, canonicalizes it, and creates a temporary local alias. A phone request cannot use this endpoint or submit a path.

## Driving an agent while you are away

Three features exist for the same reason: the point of a phone console is that you
are not sitting in front of the computer, so anything that forces you back to the
desk is a hole in the product.

### Notifications when the agent needs you

An approval, a question, a finished turn, or a failure can now reach a chat app
instead of only a page you have to be looking at. Set one environment variable and
pick a format:

```powershell
$env:AGENTBRIDGE_NOTIFY_WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
$env:AGENTBRIDGE_NOTIFY_FORMAT  = "wecom"   # json (default) | wecom | telegram | serverchan | pushplus
# telegram also needs: $env:AGENTBRIDGE_NOTIFY_CHAT_ID = "123456789"
# pushplus also needs: $env:AGENTBRIDGE_NOTIFY_TOKEN   = "你的 token"
# optional: $env:AGENTBRIDGE_NOTIFY_LINK = "1"  (adds the app link, including the access key)
```

Settings can also live in `.agentbridge/notify.json`, which is the recommended place
for the token: that directory is git-ignored, and a double-clicked launcher inherits no
shell environment, so a file works where `setx` in a previous window does not.
Environment variables still win when both exist.

```json
{
  "webhook": "https://www.pushplus.plus/send",
  "format": "pushplus",
  "token": "your-pushplus-token",
  "channel": "clawbot"
}
```

The phone has a switch for it. The drawer footer shows
`推送中（pushplus · clawbot）` with a **静音** / **开启** button, which posts
`POST /api/notifications { muted }`. Muting is a *bridge* state, not a per-device one:
it silences every notification, keeps the webhook and token intact, and is written into
`notify.json` so the switch keeps its position across restarts and works no matter how
the bridge was launched (a double-clicked shortcut inherits no shell environment, which
is exactly why the file, not `setx`, carries this). While muted, 发送测试 answers
`sent: false, reason: "muted"` instead of pretending.
`channel` is provider-specific and currently used by PushPlus: `clawbot` delivers to the
微信ClawBot channel, `wechat` to the WeChat service account, and leaving it out uses the
account default. Change the file and restart the bridge — the console then reports
`已开启（pushplus · clawbot）`, and 发送测试 posts a real message through that channel.
PushPlus is the shortest path if you only have personal WeChat: it delivers to the
PushPlus WeChat service account, so a `POST` to `https://www.pushplus.plus/send` with
`{token, title, content, template:"txt"}` is enough (the token may also sit in the URL,
as `/send/{token}` or `?token=…` — a token already in the URL is not duplicated into
the body). Other common endpoints: WeCom group bot (`wecom`), Telegram
(`https://api.telegram.org/bot<token>/sendMessage` with `chat_id`), ServerChan
(`https://sctapi.ftqq.com/<SENDKEY>.send`).

**Failures are read from the response body, not just the status code.** These services
answer `200` and put the verdict inside: WeCom uses `errcode`, PushPlus and ServerChan
use `code` (PushPlus success is exactly `200`), Telegram uses `ok`. A rejected message
therefore comes back from 发送测试 as `sent: false, reason: "provider-913:token 无效"`
instead of a false success — which is what a wrong key looks like in practice.

Only five events are forwarded — `approval.requested`, `input.requested`,
`turn.completed`, `turn.failed`, `session.failed` — because everything else is
transcript traffic the phone catches up on when it next opens. Repeats of the same
kind for the same conversation are damped for 15 seconds, so a long turn cannot
spam the chat. A dead webhook is logged and swallowed: it can never fail the turn it
describes. Without `AGENTBRIDGE_NOTIFY_WEBHOOK` the feature is inert, the console
says so, and `npm run verify:notify` still passes.

The desktop pairing panel shows whether notifications are on and offers **发送测试**,
which posts a real message through the configured channel.

### Time-boxed blanket approval

Waiting on a confirmation for every tool call defeats the purpose of leaving the
phone in your pocket. **自动放行** in the session header arms a policy for 5, 10 or 30
minutes: matching approvals are answered with `approve` automatically, and the
conversation records each one as `已自动放行（限时策略）` so the trail stays honest.

The limits are deliberate and enforced on the server, not in the UI: 30 minutes
maximum whatever the client asks for, a scope list (`shell` by default, or every
tool if you tick the box), only the phone holding the input lease may arm or cancel
it, and expiry is checked against the clock on every use. The armed state renders as
a live countdown pill — tap it to cancel — and travels in `/api/state` as
`session.autoApprove` so the desktop and phone agree.

### Searching what was said

The drawer's search box filters titles and projects locally, then asks
`GET /api/search?q=…` for matches inside message text (and tool commands). Results
show the conversation, the speaker, the time and a snippet; tapping one opens that
conversation. The search reads the in-memory window first and falls back to
`events.jsonl` for anything already evicted, keeps at most five hits per
conversation so one long chat cannot drown the list, and reports `truncated` when
the log itself was longer than the read budget.

### Surviving a bridge restart

Before this, restarting the bridge left every DSH Desktop conversation permanently
"offline": the companion's channel was gone, its polls got `401`, and the only cure
was walking back to the computer and running `/phone` again. The integration now
recognises `401/403/404/409/410` as "this channel no longer exists" and re-registers
itself — same DSH conversation, same bridge session, same input lease, no new pairing
code and no new device — with an immediate first attempt and exponential backoff up
to six tries. The register endpoint takes `reconnect: true` for exactly this case and
answers `200 { reconnected: true }` instead of minting a pairing.
### Sending a picture or a file

The phone is usually the device holding the thing the agent needs — a screenshot of
the error, a photo of the whiteboard, a log file. The composer has an attach button:
files upload as raw bytes (`POST /api/sessions/:id/attachments`, 8 MB each, six per
message), appear as pending chips, and travel with the message you send next.

How an attachment reaches the agent depends on what the provider can take:

| Agent | Images | Other files |
|---|---|---|
| Claude Code | `image` content block (base64, inline) | absolute path in the prompt |
| DeepSeek Harness (ACP) | `image` prompt block | absolute path in the prompt |
| OpenAI Codex | absolute path (`[附件] name → path`) | same |
| DSH Desktop | absolute path (the companion forwards text) | same |

Uploads live in `.agentbridge/attachments/` with a small catalog so a preview URL
survives a restart, capped at 400 files overall and 60 per conversation — oldest are
dropped first, files and all. An oversized upload answers a real `413` (the server
drains the body instead of resetting the socket, so the phone can tell "too big" from
"no connection"), and only the device holding the input lease may write into a
conversation. The transcript renders images as thumbnails backed by
`GET /api/attachments/:id`, and other files as named chips.

### Typing while the agent is working

A busy agent used to answer `409`. Now the message queues: the composer clears, the
queue appears above it as `第 1 位 · …` with a 撤回 button, and the message is sent the
moment the current turn ends. Five messages can wait; a sixth is refused with a
message that says so. The queue is part of `/api/state` (`session.queued`), so every
client shows the same list, and cancelling is `POST /api/sessions/:id/queue/cancel`.

### Speaking instead of typing

When the browser exposes a speech engine (`SpeechRecognition`/`webkitSpeechRecognition`)
the composer shows a microphone: press it, talk, and the transcript lands in the
message box for you to edit before sending. Where the engine does not exist — most
WeChat webviews — the button is simply absent, and the phone keeps the normal
keyboard instead of a button that cannot work.

### Tool calls you can actually read

A tool entry shows the command with a **复制命令** button, and output longer than 240
characters collapses into `展开完整输出（N 字符）` so one long build log cannot push the
conversation off the screen. Both are plain `<details>` and a data attribute — no
client state to desync.

### What it costs

The session header counts what can be counted: `12 轮对话 · 34 次工具`. Token totals are
added when the provider reports them (Claude does, on its result frame: `1.2k → 340
tokens`); the line never shows a number the agent did not supply.

### Caching, so opening the console is cheap

Every asset in the shell is content-addressed: `index.html` (always `no-store`)
references `/app.js?v=<hash>` and `/styles.css?v=<hash>`, the stylesheet versions the
photo it points at, and a request whose `?v=` matches is answered
`public, max-age=31536000, immutable`. Changing a file changes its stamp, so there is
no stale-asset failure mode; a stale or missing stamp falls back to `no-store`. The JS
modules share one bundle stamp (a change to `markdown.js` must also invalidate
`transcript.js`, which imports it — one stamp is simpler and correct), while the photo
is hashed on its own so replacing only the picture still busts the cache.

### Knowing when the desktop copy is old

The DSH integration is a *copy* inside the DSH profile, so editing this repository does
nothing until `npm run install:dsh-phone` runs again. The integration reports
`integrationVersion` on every register, and the desktop panel says `已连接，版本 vN` or,
if the paired companion is behind,
`桌面端集成是旧版（vN，需要 vM）：运行 npm run install:dsh-phone 并重启 DSH Desktop`.

A stale copy is not only a missing feature. A build without the reconnect logic treats
the bridge's `Invalid DSH Desktop channel` (401) as an ordinary error, so after a bridge
restart it retries that dead channel forever — around ten log lines a second in
`%APPDATA%\DSH Desktop\logs` — while the phone sees a conversation it cannot drive. The
symptom to recognise is `DSH Desktop companion is not registered` on the phone after 安全停止
and restarting the bridge.

### After a bridge restart, the phone takes the conversation back by itself

Restarting the bridge wipes every channel it handed out. The desktop companion notices the
first 401 (401/403/404/409/410 all mean "this channel no longer exists"), re-registers with
`reconnect: true`, and the bridge re-binds the *same* bridge session — same conversation,
same controller lease, no pairing code, no `/phone`. The retry has no attempt cap: only the
interval is capped (30 s), because stopping and starting the bridge by hand takes longer
than the six attempts an earlier build allowed, and giving up there left the conversation
permanently dead until someone walked back to the desktop. Only closing the DSH conversation
stops it.

Until that re-registration lands, the phone says so instead of pretending: a DSH Desktop
session with no live companion carries `desktopConnected: false`, the conversation shows a
neutral hint (`桌面端还没连上这个会话：…执行 /phone…`) rather than a red execution failure,
and the composer is disabled with a matching placeholder. It re-enables itself the moment
the companion is back.

### Questions reach the phone even when the desktop channel hiccups

A DSH Desktop question (`ask_user_question`) is not a session event: it is read from DSH's
own client stream and posted to the bridge on its own channel. Two failure shapes used to
strand it:

- **A giant event wedged the channel behind itself.** Event batches were cut by item
  count only; one 1 MB tool output pushed a batch past the bridge's limit, the bridge
  answered `Request body is too large`, and the replayed batch was refused again — forever.
  Batches are now cut by byte budget (448 KB under the bridge's 1 MB cap), and any single
  event that is still too big is shrunken at capture time (long strings clipped, and a
  stub with just the event type as a last resort), so the channel always makes progress.
- **A failed POST dropped the card.** The question's own POST used to log its failure and
  move on, so a one-second blip (bridge restarting, channel mid-reconnect) lost the card
  for the phone while the desktop kept showing it. Failed cards are now queued on the
  conversation's lifetime and retried; a reconnect re-drains the same queue on the new
  channel.

## Agent support

| Adapter | MVP status | Transport | Important behavior |
|---|---|---|---|
| Echo | Ready | In-process | Safe synchronization test |
| OpenAI Codex | Ready when installed | `codex app-server --stdio` | Streaming, cancel, approval requests, and `request_user_input` questions |
| Claude Code | Ready when installed | `claude --print --input-format stream-json` | Streaming, resume, cancel, model choice, phone approvals, and `AskUserQuestion` prompts over the control stream |
| DeepSeek Harness | Ready when official dsh is installed | `dsh --profile acp` | Independent ACP sessions, committed-answer updates, cancel, phone approvals, and `elicitation/create` questions |
| DSH Desktop current conversation | Ready after local bundle install | Public slash command + live Agent/session events | `/phone` binds exact session ID, cwd, provider, and model; bidirectional same-session sync, including questions and approvals; the phone can also open new DSH Desktop conversations while a companion is paired |
| ZCode | Official native handoff | ZCode Desktop Remote Control / Bot Channel | Bridge deliberately cannot create or attach ZCode sessions because ZCode has not published that local session API |

On Windows, the bridge resolves the installed Codex, Claude, or dsh package's native entry point. This preserves long-running stdio and avoids passing phone input through cmd.exe.

### DeepSeek Harness
Follow the official Harness quick-start and complete its local model and credential configuration. Before opening AgentBridge, make sure this command shows help instead of starting the browser UI:

~~~powershell
dsh --profile acp --help
~~~

Restart AgentBridge after installing dsh. The DeepSeek option changes from “未安装” to available only after the Bridge process can detect it. Creating a session starts one isolated official ACP connection for that project directory; it does not scrape the Harness web UI or select a model. The model and credentials remain the ones configured by Harness. Harness ACP publishes committed assistant answer blocks, so its display is accurate but not token-by-token or a mirror of its private Web UI tool timeline.

Use the current-directory launcher when appropriate:

~~~powershell
node .\bin\agentbridge.js phone --agent deepseek-harness
~~~

For a previously persisted Harness conversation, AgentBridge asks the current official ACP profile to resume the provider session ID. If the locally installed dsh version does not expose resume, the request fails visibly; it is never represented as a successful attach.

The ACP path also answers questions. ACP v1 carries them as `elicitation/create`, so the adapter advertises `clientCapabilities.elicitation.form` during `initialize` and turns a form schema into a phone card: `enum` properties become options, `boolean` becomes 是/否, `string`/`number` become a text field, and `required` is enforced before the request is retired. The reply is `{ action: "accept", content }` with values typed from the schema, because the agent validates `content` again. Skipping replies `{ action: "decline" }`. URL-mode elicitations are declined immediately — the phone has no browser hand-off — which is why only form mode is advertised.

#### DSH Desktop: pair the conversation already on screen

Install the local profile bundle once, then restart DSH Desktop:

```powershell
npm run install:dsh-phone
```

Open a conversation from the desired project folder and enter:

```text
/phone
```

The command receives the live Agent object from DSH's public command runtime. It reads the authoritative `session.id`, `session.header.cwd`, `options.provider`, and `options.model`; it does not infer a folder, scrape the window, or create a second Harness conversation. The result contains a one-time QR image and pairing URL. Scan it in WeChat to open the H5 console already bound to that exact Desktop session.

Phone messages become normal DSH follow-up messages in the same live Agent. DSH's public `session/event` stream sends Desktop-entered messages, text deltas, completed replies, tools, and turn state back to AgentBridge. Re-running `/phone` rotates the private companion credential and issues a new five-minute, single-use QR.

#### Answer the agent's question from the phone

When the agent stops to ask something — `ask_user_question` with options, or a one-off approval prompt — the turn is blocked until a human answers. `/phone` forwards those prompts through DSH's own client stream (`question/requested` and `approval/requested`) and answers them with `apiProxy.respond`, the same seam the desktop window uses. The phone renders one card per question with its options, an optional free-text field, and a skip button; answering on either side retires the card on the other.

The answer travels back through the private loopback companion and is only reported as accepted after DSH Desktop confirms it. If the desktop window answers first, the phone card is retired with “已在电脑上回答” instead of failing when tapped.

#### Choose an already configured DSH Desktop model from the phone

After `/phone` has attached a DSH Desktop conversation, the phone console shows the current DSH provider/model and the model directory returned by that exact live DSH session. Choose a model and, when the provider exposes them, a reasoning effort, then tap **切换模型**. The request is accepted only when that phone owns the input lease and the current turn is idle. AgentBridge sends the selected entry through the private loopback companion; DSH Desktop's public `session.selectModel` validates and applies it, then returns the canonical selected model to the phone.

The selector never accepts a free-form model name and it does not inspect DSH Desktop's window or modify `app.asar`. If the current DSH build cannot return a model directory, the selector remains unavailable and the phone continues to control the conversation normally.

**The selector never silently disappears.** An Agent that can switch models always shows the control; when it cannot be used the row is disabled and says why:

| State | What the phone shows |
|---|---|
| Live conversation, phone has not taken control | Enabled list, note “接管输入后才能切换模型。” |
| Live conversation, phone owns the lease and is idle | Enabled list, note names where the directory came from |
| Agent offline, directory remembered | Disabled list with the last known model preselected, note “这个会话的 Agent 当前离线：在 DSH Desktop 里运行 /phone 后即可切换模型。” |
| Agent offline, never reported a directory | Disabled row, same note plus “也还没有上报模型目录” |

That memory is durable: the model directory is written into the conversation catalog (`bridge-sessions.json`, capped at 20 providers × 40 models with their reasoning efforts) whenever a session becomes ready, so a bridge restart no longer erases which model a conversation was on. The live directory still comes from DSH and replaces the stored copy the moment the companion reconnects.

#### Create a DSH Desktop conversation from the phone

DSH Desktop conversations live inside the desktop app, so the phone cannot spawn one on its own. When a companion is paired, AgentBridge reports that Agent as creatable and asks it to open the conversation:

1. The phone opens **＋ → DeepSeek Harness Desktop** and picks the project directory.
2. AgentBridge creates the bridge session and sends a `create-session` command down the *existing* companion channel of that Agent (no second DSH process is started).
3. The companion calls DSH's agent service to create a real session in that directory, then registers it back against the bridge session that asked for it.
4. That registration completes the request: the conversation becomes ready with its model directory, and the phone that asked keeps the input lease. No second pairing code is minted.

If no companion is paired the create sheet says so — the option reads **（桌面端离线）**, the submit button is disabled, and the sheet explains that you have to run `/phone` in DSH Desktop first. The capability is evaluated per request, so the same row becomes creatable the moment the companion connects. If the desktop build cannot create conversations (a DSH build without `ctx.agents.create`), the phone gets that reason as the create result instead of a silent failure. A create request that is never answered fails after 45 seconds with the reason, and a registration that arrives for a request nobody made is rejected rather than opening a stray conversation.

AgentBridge must already be running at `http://127.0.0.1:8787`. If a different local origin is needed, start DSH Desktop with `AGENTBRIDGE_ORIGIN` set to that loopback origin. To remove the integration:

```powershell
npm run uninstall:dsh-phone
```

Installation modifies only the user Desktop profile under `%USERPROFILE%\.dsh`; it stores a backup named `package.json.agentbridge-backup` and never patches `DSH Desktop.exe` or `app.asar`.

### ZCode

ZCode is not shown as createable. Its row is an explicit official handoff: use the ZCode desktop app's [Remote Control documentation](https://zcode.z.ai/en/docs/remote-control), or its [WeChat Bot Channel](https://zcode.z.ai/en/docs/bot-channel), to control an existing ZCode desktop workspace. This distinction prevents AgentBridge from claiming it can attach to a ZCode session when the vendor has not supplied a public local session protocol.

## Configuration

AgentBridge reads environment variables; [`.env.example`](./.env.example) documents all supported values.

| Variable | Default | Meaning |
|---|---|---|
| `AGENTBRIDGE_PORT` | `8787` | HTTP listen port |
| `AGENTBRIDGE_HOST` | `0.0.0.0` | Listen address |
| `AGENTBRIDGE_PROJECTS` | current directory as `workspace` | `alias=absolute-path` allowlist separated by semicolons |
| `AGENTBRIDGE_PUBLIC_ORIGIN` | first LAN IPv4 address | Address encoded into the QR code |
| `AGENTBRIDGE_MACHINE_NAME` | OS hostname | Name shown in the console |
| `AGENTBRIDGE_DATA_DIR` | `.agentbridge` | Append-only event storage |
| `AGENTBRIDGE_PAIRING_TTL_MS` | `300000` | One-time pairing-code lifetime (5 minutes) |
| `AGENTBRIDGE_SESSION_TTL_MS` | `259200000` | Device-session lifetime (72 hours) |
| `AGENTBRIDGE_CLAUDE_MODEL` | provider setting | Optional explicit Claude Code/Kimi API model ID used for phone turns |
| `AGENTBRIDGE_CLAUDE_FIRST_OUTPUT_TIMEOUT_MS` | `30000` | Fail a Claude turn when its process produces no structured output within this many milliseconds |
| `AGENTBRIDGE_CLAUDE_INTERACTION_TIMEOUT_MS` | `300000` | Deny an unanswered Claude prompt after this long so the turn continues instead of parking |
| `AGENTBRIDGE_ACCESS_KEY` | unset | Shared gate key for public-exposure modes. The Cloudflare launcher generates and reuses one in `.agentbridge/access-key` |
| `AGENTBRIDGE_LOCAL_ORIGIN` | `http://127.0.0.1:<AGENTBRIDGE_PORT>` | Loopback origin the CLI and `/phone` talk to, when the bridge listens elsewhere locally |
| `AGENTBRIDGE_NOTIFY_WEBHOOK` | unset | Webhook for approval/question/finished/failed notifications. Unset leaves the feature inert |
| `AGENTBRIDGE_NOTIFY_FORMAT` | `json` | `json`, `wecom`, `telegram`, `serverchan`, or `pushplus` |
| `AGENTBRIDGE_NOTIFY_CHAT_ID` | unset | Telegram chat ID |
| `AGENTBRIDGE_NOTIFY_TOKEN` | unset | Provider token (PushPlus, ServerChan) |
| `AGENTBRIDGE_NOTIFY_CHANNEL` | provider default | Provider-specific channel; PushPlus uses `clawbot` or `wechat` |
| `AGENTBRIDGE_NOTIFY_LINK` | unset | `1` appends the app link, including the access key, to each notification |

If the automatically selected LAN address is not reachable from the phone, set it explicitly:

```powershell
$env:AGENTBRIDGE_PUBLIC_ORIGIN = "http://192.168.0.2:8787"
npm start
```

Windows Firewall may ask whether Node.js can accept private-network connections. Permit only the **Private network** profile if the phone must connect directly.

## Security boundary

The QR contains a short-lived, single-use pairing code, not an Agent credential. Successful exchange creates an opaque device token stored in an `HttpOnly`, `SameSite=Strict` cookie. Raw tokens are not persisted; their SHA-256 digests are held by the bridge. Mutating requests require same-origin checks, command IDs prevent accidental replay, and only one device owns a session's input lease at a time. Stop is a two-click action in the UI.

LAN, Tailscale, and ZeroTier modes use plain HTTP inside a trusted local or private virtual network. Do **not** forward port 8787 directly through a router. Cloudflare mode is different: the phone reaches a public HTTPS Tunnel, while AgentBridge additionally requires its generated access key before pairing or authenticated APIs are reachable. A long-lived multi-user public service would still require stronger account authorization, proxy identity validation, encrypted-at-rest logs, and an explicit recovery model.

Agent credentials and child processes remain on the computer. The current MVP does not yet provide multi-user authorization, encrypted-at-rest event logs, recovery of live child processes after a bridge restart, or a cloud Relay.

## WeChat scope

The implemented path is **WeChat scan → mobile H5 → local AgentBridge**. It requires no Official Account and does not automate or hook a personal WeChat client.

A production Official Account or WeCom integration is a separate channel adapter: WeChat callbacks should be converted to the same command envelope and outbound Agent events should be rendered as template/customer-service messages. That work requires an account, callback domain, app credentials, user binding, and WeChat platform review, so it is intentionally not faked in this repository.

## API map

Static shell: `/` and `/pair` serve `public/index.html`; `/app.js`, `/styles.css`, and `/transcript.js` are content-addressed entry points; `markdown.js`, `highlight.js`, `workspace-navigation.js`, `adapter-capabilities.js`, and `command-id.js` are the modules those entry points import; `/vendor/katex/*` serves KaTeX from the installed package.

**Loopback only** — the desktop page and the local CLI/companion use these, and a phone is answered `403`:

- `GET /api/health`: `{ ok, shuttingDown, lastSeq }`. The launchers and `/phone` poll it before starting a second copy, and it answers `503` while shutting down.
- `GET /api/bootstrap`, `GET /api/pairing/qr.svg`, `GET /api/local/pairings/:id/qr.svg`: desktop pairing bootstrap and QR images.
- `POST /api/pairing/rotate`: mint a fresh one-time pairing code and QR.
- `GET /api/return-qr.svg`: QR for the fixed, non-secret return address.
- `POST /api/local-session`: give the desktop page its own device session.
- `POST /api/local/phone`: current-directory/session launcher used by the CLI.
- `POST /api/local/workspaces`: register an existing local directory as a Workspace.
- `POST /api/local/dsh-desktop/register`: register the exact live DSH Agent from `/phone`; `reconnect: true` re-binds an existing conversation instead of minting a pairing.
- `POST /api/local/shutdown`: safe stop. Answers `409 ACTIVE_SESSIONS` (listing the blocking sessions) while a turn is still running.
- `POST /api/local/notify-test`: send one real message through the configured notification channel.

**Pairing and devices:**

- `POST /api/access`: exchange the Cloudflare-mode access key for a short-lived HttpOnly gate cookie.
- `POST /api/pairings/exchange`: consume the one-time code and set a device cookie.
- `GET /api/devices` and `POST /api/devices/:id/revoke`: list and revoke paired devices.
- `POST /api/recent-session`: record the calling device's last active Bridge session for safe root-address resume.

**Catalog:**

- `GET /api/state`: machine, device, adapters, Workspaces, sessions (including `session.queued` and `session.autoApprove`), and the event cursor.
- `GET /api/workspaces`: authenticated, path-redacted Workspace catalog.
- `GET /api/conversations?workspaceId=...`: read the local conversation catalog; add `adapterId=codex&refresh=1` for explicit Provider discovery.
- `GET /api/search?q=...`: search message text and tool commands, at most five hits per conversation, reporting `truncated` when the log read hit its budget.

**Events:**

- `GET /api/events?after=<seq>`: resumable SSE stream. The `after` parameter is optional; the phone relies on the browser's own `Last-Event-ID`, so an automatic reconnect resumes instead of replaying the whole buffer. A fresh page with no cursor receives only the newest 500 events.
- `GET /api/sessions/:id/history?limit=300&before=<seq>`: one conversation's history. Served from the replay window, or read back from the append-only log for a session the window has already evicted. `before` pages backwards, which is what the phone 加载更早 control uses; the response reports `hasMore` and `oldestSeq`. `no-store`.

**Commands** (device cookie required; mutating calls are same-origin checked):

- `POST /api/sessions`: create an adapter session.
- `POST /api/sessions/:id/messages`: send an idempotent command.
- `POST /api/sessions/:id/model`: apply a model and optional reasoning choice from the Provider-supplied allowlist.
- `POST /api/sessions/:id/control`: claim or explicitly take over input control.
- `POST /api/sessions/:id/stop`: interrupt the active turn.
- `POST /api/sessions/:id/auto-approve`: arm or cancel the time-boxed blanket approval. The server caps the window at 30 minutes and only the device holding the input lease may change it.
- `POST /api/sessions/:id/queue/cancel`: withdraw a queued message.
- `POST /api/sessions/:id/attachments` and `GET /api/attachments/:id`: upload raw file bytes (8 MB each, six per message) and read them back.
- `POST /api/approvals/:id`: resolve a pending approval request (Codex, DeepSeek Harness ACP, or DSH Desktop).
- `POST /api/requests/:id`: answer a pending agent question with `{ answers: [{ id, selected, custom? }] }`, or `{ cancel: true }` to skip it.
- `POST /api/notifications`: mute or unmute bridge-wide notifications (`{ muted }`).

**DSH Desktop companion channel** (authenticated with the companion credential, not the device cookie):

- `GET /api/local/dsh-desktop/channels/:id/poll`: command queue.
- `POST /api/local/dsh-desktop/channels/:id/events`: DSH event ingestion.
- `POST /api/local/dsh-desktop/channels/:id/interactions`: DSH question/approval frames (answerable, so they stay off the seq-deduplicated event stream).
- `POST /api/local/dsh-desktop/channels/:id/results`: the companion reports the outcome of a `create-session` request.
- `GET /api/local/dsh-desktop/channels/:id/qr.svg`: pairing QR for that channel.

## Verification

```powershell
npm run check
npm test
npm run verify:mobile   # optional; needs Chrome or Edge
```

The tests cover configuration, one-time and session-bound pairing, event persistence and cursors, project allowlisting, loopback current-directory registration, adapter attach/resume, DSH Desktop channel authentication and event mapping, transcript folding and history retention, delta coalescing, concurrent channel ingest ordering, idempotent plugin installation/removal, CLI skill generation, command idempotency, control leases, authenticated HTTP flows, and SSE replay.

`npm run verify:mobile` drives the real mobile page in headless Chrome against a real bridge server, using the real DSH Desktop channel pipeline, and asserts the whole conversation is displayed: after a reload, while a reply streams, and once it is committed. Set `CHROME_PATH` if the browser is not in a standard location.

The other `verify:*` scripts each boot a real bridge and a real headless browser: `verify:navigation` (drawer navigation, history paging, and a style audit that all drawer rows share one radius while the notification card's border and blur equal `.create-sheet`'s), `verify:models` (the model and reasoning popovers), `verify:scrim` (background and text contrast), `verify:notify` (the notification switch and 发送测试), `verify:attach` (upload, the thumbnail preview, and its own read-back URL), `verify:features` (three phone-only behaviours), `verify:blocks` (tables, formulas, code cards), `verify:questions` (a question answered on the phone arrives on the desktop), and `verify:quicknav` (the floating 置顶/置底 control at both layouts).

Two failure modes are covered by tests because they used to take the whole process down: an event that cannot be written to the log is reported and dropped rather than thrown back at the adapter that emitted it fire-and-forget, and a failed catalogue write no longer skips the queue, notification and log work that follows it. A `send` whose own event cannot be logged still fails with `503` — a client that is waiting for an answer should be told to retry.

## Design notes

The architecture and Happy project comparison are documented in:

- [`docs/architecture/wechat-multi-agent-remote-control.md`](./docs/architecture/wechat-multi-agent-remote-control.md)
- [`docs/软件功能与前端执行逻辑.md`](./docs/%E8%BD%AF%E4%BB%B6%E5%8A%9F%E8%83%BD%E4%B8%8E%E5%89%8D%E7%AB%AF%E6%89%A7%E8%A1%8C%E9%80%BB%E8%BE%91.md)

Happy is useful mainly as validation of the local daemon + remote client + session streaming shape. AgentBridge deliberately adds a WeChat-friendly pairing/channel layer, a capability-driven multi-Agent adapter boundary, explicit control leases, and server-side project aliases instead of copying Happy wholesale.

### Streaming and the conversation window

Agents emit one event per token, and a single long turn can produce thousands of them. Over a tunnel to a phone that traffic is what used to make the console crawl and arrive incomplete, so the pipeline treats token deltas as progress rather than history:

- `SessionManager` coalesces deltas per turn (about 120 ms) and addresses each chunk by character `offset`. Any non-delta event flushes first, so a committed message always lands after its own streamed prefix.
- `EventStore` keeps at most one delta per turn, merging later chunks into it, so the replay window stays full of messages instead of tokens. Committed messages and status changes are never evicted by token chatter. The on-disk log still records each chunk as it arrived.
- Clients fold deltas with `text = current.slice(0, offset) + text`, which is idempotent: a merged snapshot, a replay, or an out-of-order chunk rewrites the same text instead of duplicating or losing it.
- `public/transcript.js` holds that folding logic plus entry building, so it can be tested directly with Node and the real Markdown renderer. `public/app.js` only does DOM work: it renders on a throttle, diffs entries by key, and rewrites just the reply that is still growing.

A phone that reconnects mid-turn still sees the in-progress text, because the retained delta carries everything streamed so far.

### Background image

The photo is shown **as-is**: no `filter` (no blur), no plate behind the text, and one whole-page white veil over it. `public/background.jpg` is painted full-viewport with `background-size: cover` on one fixed layer (`body::before`), so every screen fills itself and crops instead of stretching. The current picture is a `2048×1152` landscape (16:9) shot of the Jade Dragon mountain — re-encoded from the `3.3 MB` source PNG to a `456 KB` JPEG at quality 92 (mean channel delta against quality 94 is `1.06/255`, i.e. invisible, for 11% fewer bytes). At 16:9 the source fits the viewport *height* on both a portrait phone and a wide window, so all cropping is horizontal and only `background-position`'s **X** does anything: it is `0% center` at every width (see below for why). It uses a fixed pseudo-element rather than `background-attachment: fixed`, which jitters inside the WeChat webview. One trap matters: the photo sits at `z-index: -2`, and a non-transparent `body` background paints *over* negative z-index children, so `body` must stay `transparent` and the base colour lives on `html` instead.

The crop is centred (`background-position: center`). At 16:9 the source fits the viewport height on both a portrait phone and a wide window, so all cropping is horizontal; centring keeps the mountain ridge in frame on every screen, which is the point of using a landscape photo at all.
### The scrim: one white veil

`body::after` is a single fixed, full-viewport layer at `z-index: -1` with `pointer-events: none` and one declaration: `background: rgba(255, 255, 255, 0.58)`. No blend mode, no mask, no second colour — the photo sits underneath and a uniformly translucent white sheet sits on top.

The alpha is the only parameter, and it was measured rather than guessed. Body text `#14141c` needs the darkest possible backdrop to stay above `6:1` (below that the same text reads fuzzy on a mid tone, which is a measured threshold, not a taste):

| Veil alpha | Phone body contrast | Desktop body contrast | Photo saturation kept |
|---|---|---|---|
| `0.55` | 5.74:1 | 6.11:1 | 45% |
| **`0.58` (shipped)** | **6.28:1** | **6.69:1** | **42%** |
| `0.62` | 7.09:1 | 7.46:1 | 38% |

`0.58` is the smallest alpha that clears `6:1` on both, so it keeps the most photo. Measured on the shipped values at 390×844, 1440×1000 and 320×568: body `6.28–6.69:1`, secondary text `#2b3038` `6.03–6.43:1`, user messages 4.90:1, italic labels 4.84:1, error lines 4.65:1 — everything above AA. Texture survives at `65%`, hue rotation is `3.4°`, and `0.1–0.2%` of pixels clip toward white.

What this design costs, stated plainly: the veil is uniform, so it mixes white into *every* pixel, including the bright snow. The photo keeps its composition and its colour family (hue rotation 3.4°) but loses saturation — measured `42%` of the original chroma. That is the price of three lines of CSS instead of a masked, blended lift; the earlier masked `screen` version kept `70%` of the phone's pixels byte-identical and `88%` of the texture where it acted, at the cost of a generated mask asset and a much longer rule.

`prefers-reduced-transparency: reduce` and `prefers-contrast: more` raise the veil to `--bg-scrim-veil-solid` (`rgba(255,255,255,0.72)`). Text surfaces stay transparent: `.event-entry`, `.session-header` and `.empty-state` all compute to `background: rgba(0, 0, 0, 0)`, and no glyph carries a `text-shadow` halo (an earlier revision did, and that halo is what made text look blurred).
### Why the background can differ from the original file

Three things can change it, measured separately:

| Source of change | Size | Verdict |
|---|---|---|
| PNG → JPEG re-encode (quality 92) | mean channel difference `1.3 / 1.2 / 1.5` out of 255 (0.5%) | invisible; chroma 10.2 → 10.3 |
| The white veil | hue rotation `3.4°`, saturation `42%`, texture `65%` | colour family survives; the picture reads lighter and less saturated |
| The `cover` crop | a portrait phone sees a 532 px slice of the 2048 px original | unavoidable; centring picks the middle slice |

So: the file itself is faithful, and the hue is faithful too (`3.4°`). What a uniform white veil changes is **brightness and saturation** — it lifts the whole picture toward white by the same amount everywhere, which is exactly what it is for, and exactly why half a stop of colour disappears with it.

If you want the photo closer to the file, the levers are, in order of effort: lower `--bg-scrim-veil` (each `0.04` of alpha costs about `0.5:1` of body contrast — `0.50` lands near `5.4:1`, which is above AA but in the "soft" band); change `background-position` so the visible slice is a brighter part of the picture (a brighter slice needs a weaker veil, because contrast depends on the darkest pixel behind text); or go back to a masked lift, which is what the repository did before this simplification.
### How message content is presented

Agent answers mix prose, tables, formulas and code, and rendering all of it as one paragraph is what makes the important part hard to find. Each block type is rendered by its own kind, and every one of them is escaped first, so model output still cannot inject HTML:

| Content | Rendering |
|---|---|
| Table (`\| a \| b \|` plus a `---` rule) | A real `<table>` with a header row, zebra striping, and per-column alignment from `:---` / `---:` / `:---:`. The table scrolls inside its own box so a narrow phone never scrolls sideways. A pipe line without a separator stays prose. |
| Formula | `$inline$`, `\(inline\)`, `$$block$$` and `\[block\]` are typeset by KaTeX, fetched on demand from this bridge (never a CDN) and rendered with `trust: false`, so `\href`/`\htmlClass` cannot become an injection route. Inline code wins over math, and `$5 与 $10` stays money because a dollar pair with a space inside, or a digit right after the closer, is not treated as math. |
| Fenced code | Its own card: a language badge from the fence info string, a 复制 button that copies the source text, dark surface, and horizontal scroll without wrapping. Comments, strings, numbers and keywords are coloured by a 6.8 KB local highlighter (`public/highlight.js`) covering JavaScript/TypeScript, Python, shell, JSON, CSS, HTML, SQL, YAML, Go, Rust and the C family. An unknown fence language falls back to escaped plain text, and every language keeps the source byte-for-byte identical. |
| Headings, lists, quotes, rules | Kept from the previous subset, with spacing that separates sections from prose. |

KaTeX is a dependency rather than a vendored blob, so `npm install` is enough; `/vendor/katex/*` serves only its own asset types from the installed package. The page keeps `script-src 'self'` and allows inline styles only because KaTeX positions every glyph with a style attribute.

`npm run verify:blocks` checks this in a real browser at 390×844: the table is a table with aligned columns, the formula is typeset with KaTeX's own font, the code card offers copy, and the page does not scroll horizontally.

### Switching conversations and loading history

History used to arrive only through one global replay, and that caused both symptoms people hit when switching conversations — an empty transcript, or one that crawled in for a long time:

- A fresh page had no cursor, so the server replayed the whole in-memory window. Measured on a real log that was **3.09 MB**, of which 35% was `session.ready` repeating the entire model directory (~43 KB per attach) and 43% was raw tool arguments and tool output. Over a tunnel that is many seconds before anything appears.
- The window is global (`maxMemory` events across every conversation) and the client trims its own buffer, so a quiet conversation could be pushed out entirely. Selecting it rendered an empty log with no way to get it back, because nothing served one conversation's history.

Both are fixed:

- A fresh page receives only the newest `INITIAL_REPLAY_EVENTS` (500) events — **0.71 MB** on the same log. Reconnects still resume from the browser's `Last-Event-ID`, so an open page keeps its cursor.
- `GET /api/sessions/:id/history?limit=300` serves one conversation, authenticated and `no-store`. The store answers from memory while nothing has been evicted; once the window has dropped anything, it reads that session back from the append-only log, so an evicted conversation still loads. The phone fetches it once per conversation per page load and merges by `eventId` and `seq`, which is idempotent against a stream that is still arriving (measured: 18 KB–453 KB per conversation instead of 3.09 MB).
- Trimming now evicts other conversations' oldest events first (`keepSessionId`), because a freshly fetched page is the oldest data in the buffer.
- The log says **正在载入历史** while a fetch is in flight and **这段会话还没有记录** when the computer genuinely has nothing, instead of the old "准备好了 / 从第一条指令开始", which read as a failed load.
- Status events no longer embed the session view, and tool commands/output are capped (2 KB / 4 KB with an explicit 已截断 marker). Conversation text is never truncated.

