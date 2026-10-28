import { createCommandId } from "/command-id.js";
import { absorbEvent, buildEntries, bumpRenderGeneration, indexDeltas, mergeHistory, trimEvents } from "/transcript.js";
import { adapterCreationPresentation } from "/adapter-capabilities.js";
import { buildAgentDrawer, discoverableAdapters, relativeTimeLabel, resolveWorkspaceNavigation } from "/workspace-navigation.js";

const $ = (selector) => document.querySelector(selector);

const model = {
  state: null,
  events: [],
  selectedId: null,
  selectedWorkspaceId: null,
  lastSeq: 0,
  stream: null,
  bootstrap: null,
  stopConfirmUntil: 0,
  shutdownConfirmUntil: 0,
  sessionSignature: "",
  workspaceSignature: "",
  discoveryLoading: false,
  discoveryMessage: "",
  renderTimer: null,
  deltaEvents: new Map(),
  // Per session: "loading" | "loaded" | "failed". History is fetched once per
  // conversation per page load instead of relying on one global replay.
  historyStatus: new Map(),
  // Ids already in `events`. Fetched history and the live stream describe the
  // same event, and either can arrive first, so both paths consult this set.
  eventIds: new Set(),
  // Per session: the seq to page before, and whether anything precedes it.
  historyMeta: new Map(),
  // Session id whose earlier page is being fetched right now.
  historyLoading: null,
  // Set once KaTeX is usable; transcript entries are re-rendered at that point.
  mathRenderer: null,
  // Drawer state: which Agents and projects are open, and what is typed in its
  // search box. `null` means nothing has been remembered yet, so the tree opens
  // along the selected conversation instead of showing a collapsed list.
  drawer: { open: false, query: "", expandedAgents: null, collapsedProjects: [] },
  // 深搜：抽屉先按标题/项目本地过滤，再向服务端问"所有会话里提到过什么"
  deepSearch: { query: "", loading: false, hits: [], error: "", truncated: false },
  deepSearchTimer: null,
  pendingAttachments: [],
};

const DRAWER_KEY = "agentbridge.drawer.expansion";

function loadDrawerExpansion() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAWER_KEY) ?? "null");
    if (!stored) return { expandedAgents: null, collapsedProjects: [] };
    return {
      expandedAgents: Array.isArray(stored.agents) ? stored.agents : null,
      collapsedProjects: Array.isArray(stored.collapsedProjects) ? stored.collapsedProjects : [],
    };
  } catch {
    return { expandedAgents: null, collapsedProjects: [] };
  }
}

function saveDrawerExpansion() {
  const { expandedAgents, collapsedProjects } = model.drawer;
  if (expandedAgents === null) return;
  try {
    localStorage.setItem(DRAWER_KEY, JSON.stringify({ agents: expandedAgents, collapsedProjects }));
  } catch {
    // Private browsing may block storage; expansion simply resets next time.
  }
}

function toggleDrawerExpansion(kind, id) {
  if (kind === "agent") {
    // Materialise "nothing remembered" into a real list on the first tap, or the
    // cold-start default would immediately re-open what was just closed.
    const current = model.drawer.expandedAgents ?? [];
    model.drawer.expandedAgents = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id];
  } else {
    const current = model.drawer.collapsedProjects;
    model.drawer.collapsedProjects = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id];
  }
  saveDrawerExpansion();
  renderDrawer();
}

function setDrawerOpen(open) {
  const drawer = $("#agent-drawer");
  const mask = $("#drawer-mask");
  const toggle = $("#drawer-toggle");
  if (!drawer || !toggle) return;
  // On a wide window the drawer is the permanent sidebar: "closing" it would
  // leave the console with no navigation at all.
  if (drawerIsPermanent()) {
    model.drawer.open = true;
    drawer.classList.add("open");
    drawer.removeAttribute("inert");
    mask.classList.remove("open");
    mask.hidden = true;
    toggle.setAttribute("aria-expanded", "true");
    renderDrawer();
    return;
  }
  model.drawer.open = open;
  drawer.classList.toggle("open", open);
  if (open) {
    drawer.removeAttribute("inert");
    mask.hidden = false;
    requestAnimationFrame(() => mask.classList.add("open"));
    toggle.setAttribute("aria-expanded", "true");
    renderDrawer();
    $("#drawer-query")?.focus({ preventScroll: true });
    return;
  }
  drawer.setAttribute("inert", "");
  mask.classList.remove("open");
  mask.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.focus({ preventScroll: true });
}

function drawerSessionRow(session, currentSessionId) {
  const active = session.id === currentSessionId;
  return `<button class="drawer-session${active ? " active" : ""}" data-session="${escapeHtml(session.id)}" type="button"${active ? ' aria-current="true"' : ""}>
    <span class="status-mark ${escapeHtml(session.status)}" aria-label="${escapeHtml(statusLabel(session.status))}"></span>
    <span class="drawer-session-body">
      <span class="drawer-session-title">${escapeHtml(session.title)}</span>
      <span class="drawer-session-meta">${escapeHtml(session.workspaceName)} · ${escapeHtml(relativeTimeLabel(session.lastActiveAt))}</span>
    </span>
  </button>`;
}

// The drawer is the phone's only navigation surface, so it is rebuilt from the
// same catalog the desktop rail uses — Agent first, because which tool owns a
// conversation is the choice people actually have to make.
function renderDrawer() {
  const tree = $("#drawer-tree");
  if (!tree || !model.state) return;
  tree.dataset.query = model.drawer.query;
  const groups = buildAgentDrawer({
    sessions: model.state.sessions ?? [],
    workspaces: model.state.workspaces ?? [],
    adapters: model.state.adapters ?? [],
    selectedSessionId: model.selectedId,
    query: model.drawer.query,
    expandedAgents: model.drawer.expandedAgents,
    collapsedProjects: model.drawer.collapsedProjects,
  });
  const session = currentSession();
  $("#drawer-title").textContent = session?.title ?? "会话";
  renderDrawerNotifications();
  $("#drawer-subtitle").textContent = session
    ? `${session.adapterId} · ${session.projectAlias}`
    : "按 Agent 与项目浏览";
  $("#drawer-discover").hidden = discoverableAdapters(model.state.adapters ?? []).length === 0;
  $("#drawer-refresh").disabled = false;

  if (!groups.length) {
    tree.innerHTML = `<p class="drawer-empty">没有匹配的会话。试试项目名或 Agent 名。</p>`;
    return;
  }

  tree.innerHTML = groups.map((group) => {
    const badgeClass = group.capability === "attach" ? " attach" : group.capability === "unavailable" ? " unavailable" : "";
    const head = `<button class="drawer-agent" data-agent="${escapeHtml(group.id)}" type="button" aria-expanded="${group.expanded ? "true" : "false"}">
      <svg class="drawer-chevron" aria-hidden="true"><use href="#icon-chevron"/></svg>
      <span class="drawer-agent-label">${escapeHtml(group.label)}</span>
      <span class="drawer-agent-badge${badgeClass}">${escapeHtml(group.capabilityLabel)}</span>
      <span class="drawer-agent-count">${group.sessionCount || ""}</span>
    </button>`;
    if (group.empty) {
      return `<div class="drawer-group">${head}<p class="drawer-empty">${escapeHtml(group.note ?? "没有可用的会话记录")}</p></div>`;
    }
    if (!group.expanded) return `<div class="drawer-group">${head}</div>`;
    const projects = group.workspaces.map((project) => {
      const rows = project.sessions.map((entry) => drawerSessionRow(entry, model.selectedId)).join("");
      if (project.skipProjectRow) {
        return `<div class="drawer-sessions" style="padding-left:8px">${rows}</div>`;
      }
      return `<div class="drawer-project-block">
        <button class="drawer-project" data-project="${escapeHtml(project.id)}" type="button" aria-expanded="${project.expanded ? "true" : "false"}">
          <svg class="drawer-chevron" aria-hidden="true"><use href="#icon-chevron"/></svg>
          <span class="drawer-project-label">${escapeHtml(project.name)}</span>
          <span class="drawer-project-count">${project.sessionCount}</span>
        </button>
        ${project.expanded ? `<div class="drawer-sessions">${rows}</div>` : ""}
      </div>`;
    }).join("");
    return `<div class="drawer-group">${head}<div class="drawer-projects">${projects}</div></div>`;
  }).join("");
}

// Formulas are the only block type needing a real typesetting engine, and most
// conversations have none, so KaTeX is fetched on demand from this same bridge
// (never a CDN) rather than shipped with the app shell.
function loadKatex() {
  if (model.katexPromise) return model.katexPromise;
  model.katexPromise = new Promise((resolve) => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/vendor/katex/katex.min.css";
    document.head.append(stylesheet);
    const script = document.createElement("script");
    script.src = "/vendor/katex/katex.min.js";
    script.async = true;
    script.onload = () => {
      const katex = window.katex;
      if (!katex) return resolve(null);
      resolve((tex, display) => katex.renderToString(tex, {
        displayMode: display === true,
        throwOnError: false,
        strict: "ignore",
        // `trust: false` is what keeps \href and \htmlClass from becoming an
        // injection route through model-produced TeX.
        trust: false,
        output: "html",
      }));
    };
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  return model.katexPromise;
}

async function enableMathRendering() {
  const renderer = await loadKatex();
  if (!renderer) return;
  model.mathRenderer = renderer;
  bumpRenderGeneration();
  renderedEntries = [];
  scheduleRender();
}

// The transcript is rebuilt at most this often instead of once per event. A
// streamed turn can deliver hundreds of events per second; re-rendering for
// each one is what made the phone stall while an answer was arriving.
const RENDER_INTERVAL_MS = 80;
const LOG_EMPTY_STATE = `<div class="empty-state"><div class="empty-rule"></div><h2>准备好了</h2><p>从下方发送第一条指令。真实 Agent 可能请求访问文件或运行命令。</p></div>`;
const LOG_LOADING_STATE = `<div class="empty-state"><div class="empty-rule"></div><h2>正在载入历史</h2><p>正在向电脑读取这段会话的记录。</p></div>`;
const LOG_NO_HISTORY_STATE = `<div class="empty-state"><div class="empty-rule"></div><h2>这段会话还没有记录</h2><p>电脑上暂时没有可显示的事件；发送一条消息后会从这里继续。</p></div>`;
// A conversation's history is read on demand; the initial stream only carries the
// newest slice of the global log.
const HISTORY_LIMIT = 300;

async function ensureHistory(sessionId) {
  if (!sessionId) return;
  const status = model.historyStatus.get(sessionId);
  if (status === "loading" || status === "loaded") return;
  model.historyStatus.set(sessionId, "loading");
  scheduleRender();
  try {
    const history = await api(`/api/sessions/${encodeURIComponent(sessionId)}/history?limit=${HISTORY_LIMIT}`);
    mergeHistory(model.events, model.deltaEvents, history.events, model.eventIds);
    model.historyMeta.set(sessionId, {
      oldestSeq: history.oldestSeq ?? null,
      hasMore: history.hasMore === true,
    });
    if (trimEvents(model.events, model.deltaEvents, { keepSessionId: model.selectedId })) {
      // Trimming drops events, so the seen-id set is rebuilt from what survived
      // instead of growing forever.
      model.eventIds = new Set(model.events.map((event) => event.eventId).filter(Boolean));
    }
    model.historyStatus.set(sessionId, "loaded");
  } catch (error) {
    model.historyStatus.set(sessionId, "failed");
    toast(`历史载入失败：${error.message}`);
  }
  scheduleRender();
}

function scheduleRender() {
  if (model.renderTimer || !model.state) return;
  model.renderTimer = setTimeout(() => {
    model.renderTimer = null;
    renderState();
  }, RENDER_INTERVAL_MS);
}

function commandId() {
  return createCommandId();
}

// 回答提问与批准工具调用都要先持有控制权。桌面端执行 /phone 时会替电脑占住那份租约，
// 于是手机上点「提交回答」会被拒——而这张卡片本身没有接管入口，用户只能自己去顶栏找
// 「接管输入」。点按本身就是明确的驱动意图，所以这里自动接管一次再重试。
// 每次尝试都要新的 commandId：桥按 commandId 幂等缓存（连失败一起缓存），复用同一个
// id 只会把上一次的拒绝原样回放。
async function resolveRequest(requestId, body) {
  const post = () => api(`/api/requests/${encodeURIComponent(requestId)}`, {
    method: "POST",
    body: JSON.stringify({ ...body, commandId: commandId() }),
  });
  try {
    return await post();
  } catch (error) {
    if (error.code !== "CONTROL_REQUIRED") throw error;
    await api(`/api/sessions/${encodeURIComponent(model.selectedId)}/control`, {
      method: "POST",
      body: JSON.stringify({ commandId: commandId(), force: true }),
    });
    const result = await post();
    toast("已接管输入");
    return result;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers ?? {}) } : options.headers,
  });
  const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error ?? `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = body?.code;
    error.diagnostics = body?.diagnostics;
    throw error;
  }
  return body;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4200);
}

// WeChat's webview does not always expose the async clipboard API, so a hidden
// textarea plus execCommand remains the fallback for both copy affordances.
async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function setConnection(status, label) {
  const element = $("#connection-status");
  element.className = `connection ${status}`;
  element.lastElementChild.textContent = label;
}

async function pairFromUrl() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return {};
  $("#pairing-screen").hidden = false;
  try {
    const result = await api("/api/pairings/exchange", {
      method: "POST",
      body: JSON.stringify({ code, deviceName: /MicroMessenger/i.test(navigator.userAgent) ? "微信手机" : "移动浏览器" }),
    });
    history.replaceState({}, "", "/");
    $("#pairing-message").textContent = "配对成功，正在载入安全控制台。";
    return result;
  } catch (error) {
    $("#pairing-message").textContent = `${error.message}。请回到电脑刷新二维码后重试。`;
    $(".loader").hidden = true;
    throw error;
  }
}

// A pairing QR may carry ?key=... when the access-key gate is enabled. Swap it
// for an HttpOnly cookie before anything else, then strip it from the URL so it
// never lingers in browser history.
async function storeAccessKeyFromUrl() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (!key) return;
  await api("/api/access", { method: "POST", body: JSON.stringify({ key }) });
  params.delete("key");
  const query = params.toString();
  history.replaceState({}, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

function showAccessScreen(message) {
  $("#pairing-screen").hidden = true;
  $("#app").hidden = true;
  $("#access-message").textContent = message;
  $("#access-screen").hidden = false;
}

async function ensureSession() {
  try {
    return await api("/api/state");
  } catch (error) {
    if (/Access key/.test(error.message)) {
      showAccessScreen("此实例已开启公网保护。请重新扫描电脑上的二维码，或输入启动器窗口中显示的访问密钥。");
      throw error;
    }
    if (!/Authentication/.test(error.message)) throw error;
    if (!isLoopbackPage()) {
      throw new Error("此手机尚未配对，或登录已过期。请扫描电脑上的一次性二维码后再试。");
    }
    await api("/api/local-session", { method: "POST" });
    return api("/api/state");
  }
}

function isLoopbackPage() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

function returnUrl() {
  if (model.bootstrap?.pairing?.url) return `${new URL(model.bootstrap.pairing.url).origin}/`;
  return `${location.origin}/`;
}

async function rememberSession(sessionId = model.selectedId) {
  if (!sessionId) return;
  await api("/api/recent-session", { method: "POST", body: JSON.stringify({ sessionId }) });
  if (model.state?.device) model.state.device.lastSessionId = sessionId;
}

function renderReturnEntry() {
  const url = returnUrl();
  $("#return-entry").hidden = false;
  try {
    applyReturnDetails(localStorage.getItem(RETURN_DETAILS_KEY) === "1");
  } catch {
    applyReturnDetails(false);
  }
  $("#return-url").textContent = url;
  if (model.bootstrap) {
    $("#desktop-return-url").textContent = url;
    $("#return-qr").src = `/api/return-qr.svg?t=${Date.now()}`;
  }
}

async function loadBootstrap() {
  try {
    model.bootstrap = await api("/api/bootstrap");
    $("#desktop-pairing").hidden = false;
    $("#pairing-url").textContent = model.bootstrap.pairing.url;
    $("#pairing-qr").src = `/api/pairing/qr.svg?t=${Date.now()}`;
    await loadDevices();
    renderNotifications();
    renderIntegrationStatus();
    renderDrawerNotifications();
  } catch {
    model.bootstrap = null;
  }
}

function deviceRow(device, currentDeviceId) {
  const row = document.createElement("li");
  row.className = "device-row";
  const label = document.createElement("span");
  label.className = "device-name";
  const expires = new Date(device.expiresAt).toLocaleDateString();
  label.textContent = device.id === currentDeviceId
    ? `${device.deviceName}（本设备）`
    : `${device.deviceName} · ${expires} 到期`;
  row.append(label);
  if (device.id !== currentDeviceId) {
    const button = document.createElement("button");
    button.className = "text-button device-revoke";
    button.type = "button";
    button.textContent = "撤销";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/devices/${encodeURIComponent(device.id)}/revoke`, { method: "POST" });
        toast(`已撤销 ${device.deviceName} 的访问权限`);
        await loadDevices();
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    });
    row.append(button);
  }
  return row;
}

function renderNotifications() {
  const notifications = model.state?.notifications;
  const note = $("#notify-note");
  const button = $("#notify-test");
  if (!note || !button) return;
  if (notifications?.enabled) {
    note.textContent = `已开启（${notifications.format}）：Agent 需要批准、等你回答、或回合结束时都会推送。`;
    button.hidden = false;
  } else {
    note.textContent = "未配置。设置 AGENTBRIDGE_NOTIFY_WEBHOOK 后，Agent 需要批准或跑完时会推送到你的聊天工具。";
    button.hidden = true;
  }
}

async function loadDevices() {
  try {
    const { devices, currentDeviceId } = await api("/api/devices");
    const list = $("#device-list");
    if (!devices.length) {
      const empty = document.createElement("li");
      empty.className = "device-empty";
      empty.textContent = "暂无已配对设备。手机扫码配对后会显示在这里。";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...devices.map((device) => deviceRow(device, currentDeviceId)));
  } catch {
    // Devices section is informational; leave the list empty on failure.
  }
}

function currentSession() {
  return model.state?.sessions.find((session) => session.id === model.selectedId) ?? null;
}

function currentWorkspace() {
  return model.state?.workspaces?.find((workspace) => workspace.id === model.selectedWorkspaceId) ?? null;
}


function statusLabel(status) {
  return ({ starting: "启动中", ready: "就绪", running: "执行中", failed: "失败", offline: "离线" })[status] ?? status;
}

function eventStatusLabel(kind) {
  return ({
    "session.created": "会话已创建",
    "session.ready": "Agent 已就绪",
    "turn.started": "本轮已开始",
    "turn.completed": "本轮已完成",
    "turn.cancelled": "本轮已取消",
    "control.granted": "输入控制权已更新",
    "turn.stop_requested": "已请求停止本轮",
    "model.changed": "模型已切换",
  })[kind] ?? kind;
}

function renderState() {
  if (!model.state) return;
  $("#machine-name").textContent = model.state.machine.name;
  const navigation = resolveWorkspaceNavigation({
    workspaces: model.state.workspaces,
    sessions: model.state.sessions,
    selectedWorkspaceId: model.selectedWorkspaceId,
    selectedSessionId: model.selectedId,
  });
  model.selectedWorkspaceId = navigation.workspaceId;
  model.selectedId = navigation.sessionId;
  // The drawer is the only navigation surface now. It is rebuilt from the same
  // catalog every time, because a status change is exactly what a reader needs
  // to see reflected in the list.
  renderDrawer();
  renderSession();
}

function selectedSessionModel() {
  try { return JSON.parse($("#model-select").value); } catch { return null; }
}

function renderReasoningOptions(directory) {
  const selected = selectedSessionModel();
  const target = directory?.groups.find((group) => group.id === selected?.provider)?.models.find((entry) => entry.id === selected?.model);
  const control = $("#reasoning-control");
  const select = $("#reasoning-select");
  const efforts = target?.reasoning?.efforts ?? [];
  control.hidden = efforts.length === 0;
  select.innerHTML = `<option value="">使用 DSH 默认推理强度</option>${efforts.map((effort) => `<option value="${escapeHtml(effort.id)}" ${directory.current?.reasoningEffort === effort.id ? "selected" : ""}>${escapeHtml(effort.name)}</option>`).join("")}`;
  renderPicker("reasoning");
}

function adapterEntry(adapterId) {
  return (model.state?.adapters ?? []).find((entry) => entry.id === adapterId) ?? null;
}

function renderModelControl(session, ownsControl) {
  const control = $("#model-control");
  const directory = session.modelDirectory;
  const adapter = adapterEntry(session.adapterId);
  // The control used to disappear entirely when an Agent had not reported a
  // directory yet, which reads as "the feature is gone". Show it whenever the
  // Agent can switch models at all, and say why it is locked.
  const supported = adapter ? adapter.capabilities?.selectModel !== false : true;
  control.hidden = !supported;
  if (!supported) return;
  const isCcSwitch = directory?.source === "cc-switch";
  const label = isCcSwitch ? "CC Switch 模型" : session.adapterId === "deepseek-harness-desktop" ? "DSH 模型" : session.adapterId === "codex" ? "Codex 模型" : "会话模型";
  $("#model-label").textContent = label;
  $("#model-select").setAttribute("aria-label", label);
  const select = $("#model-select");
  const choices = (directory?.groups ?? []).flatMap((group) => group.models.map((entry) => ({ provider: group.id, model: entry.id, label: `${group.name} · ${entry.name}` })));
  select.innerHTML = choices.length
    ? choices.map((entry) => {
      const value = JSON.stringify({ provider: entry.provider, model: entry.model });
      const selected = directory?.current?.provider === entry.provider && directory?.current?.model === entry.model;
      return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(entry.label)}</option>`;
    }).join("")
    : `<option value="">${directory ? "Agent 未提供可切换模型" : "还没有模型目录"}</option>`;
  renderReasoningOptions(directory);
  renderPicker("model");
  const isIdle = session.status !== "running";
  const offline = session.status === "offline" || session.status === "failed";
  const enabled = choices.length > 0 && ownsControl && isIdle && !offline;
  select.disabled = !enabled;
  $("#reasoning-select").disabled = !enabled;
  $("#apply-model").disabled = !enabled;
  renderPicker("model");
  renderPicker("reasoning");
  const failure = directory?.failures?.[0]?.message;
  // An offline Agent outranks every other reason: taking control cannot help until
  // the desktop side is running again, so that is what the note has to say.
  $("#model-note").textContent = offline
    ? directory
      ? "这个会话的 Agent 当前离线：在 DSH Desktop 里运行 /phone 后即可切换模型。"
      : "这个会话的 Agent 当前离线，也还没有上报模型目录：在 DSH Desktop 里运行 /phone 后再看。"
    : !directory
      ? "Agent 还没有上报模型目录，连上之后这里会解锁。"
      : failure
        ? `模型目录部分不可用：${failure}`
        : !directory.current ? `${isCcSwitch ? "CC Switch 未报告可识别的当前模型；可以从当前厂商目录选择一个模型。" : "Agent 未报告当前模型；可以从已配置目录选择一个模型。"}`
          : !ownsControl ? "接管输入后才能切换模型。"
            : !isIdle ? "等待当前 Agent 回合结束后再切换模型。"
              : isCcSwitch ? "仅影响此手机会话后续的 Claude 回合；不会改动 CC Switch 厂商、密钥或代理。"
                : session.adapterId === "codex" ? "模型与推理档位来自本机 Codex 当前账户；仅影响此会话后续回合。"
                  : directory.routable ? "模型列表来自当前 DSH Desktop 配置。" : "当前 Agent 模型不可路由。";
}

function renderSession() {
  const session = currentSession();
  $("#empty-state").hidden = Boolean(session);
  $("#session-view").hidden = !session;
  if (!session) {
    const hasSessions = (model.state?.sessions ?? []).length > 0;
    $("#empty-title").textContent = hasSessions ? "选择一个会话" : "还没有会话";
    $("#empty-description").textContent = hasSessions
      ? "点左上角 ☰ 按 Agent 与项目挑选会话。"
      : "点左上角 ☰ 后选 ＋ 新建会话，或在抽屉底部用「同步历史」读取 Agent 的公开会话。";
    renderQuickNav();
    return;
  }

  $("#session-title-heading").textContent = session.title;
  $("#session-adapter").textContent = session.adapterId;
  $("#session-project").textContent = session.projectAlias;
  // A DSH Desktop conversation only exists inside the desktop app, so without its
  // companion channel there is nothing to send to. Saying that up front — and in words
  // that name the one action that fixes it — beats a red "执行失败" for what is really
  // "the desktop side is not connected right now".
  const desktopOffline = session.desktopConnected === false;
  const sessionHint = desktopOffline
    ? "桌面端还没连上这个会话：在这台电脑的 DSH Desktop 里打开该会话并执行 /phone。之后手机会自动接回，不用重新扫码。"
    : "";
  const sessionError = $("#session-error");
  sessionError.hidden = !sessionHint && !session.lastError;
  sessionError.classList.toggle("hint", Boolean(sessionHint));
  sessionError.setAttribute("role", sessionHint ? "status" : "alert");
  sessionError.textContent = sessionHint || (session.lastError ? `执行失败：${session.lastError}` : "");
  const ownsControl = session.controller?.deviceId === model.state.device.id;
  const canSend = session.status !== "running" && !desktopOffline && (!session.controller || ownsControl);
  $("#control-status").textContent = ownsControl
    ? `当前由此设备控制，租约至 ${new Date(session.controller.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : session.controller ? `当前由 ${session.controller.deviceName} 控制` : "发送首条消息时自动获得控制权";
  $("#take-control").hidden = ownsControl || !session.controller;
  $("#composer").querySelector("button").disabled = !canSend;
  $("#message-input").disabled = !canSend;
  $("#message-input").placeholder = desktopOffline
    ? "桌面端未连接：先在电脑上那个会话里执行 /phone…"
    : session.status === "running"
      ? "Agent 正在执行，完成后可继续…"
      : !session.controller ? "发送第一条指令并取得控制权…" : ownsControl ? "继续给 Agent 指令…" : "先接管输入再发送…";
  const stopButton = $("#stop-session");
  stopButton.hidden = session.status !== "running";
  stopButton.disabled = !ownsControl;
  stopButton.title = ownsControl ? "停止当前执行" : "只有当前控制设备可以停止执行";
  renderModelControl(session, ownsControl);
  renderAutoApprove(session);
  renderQueuedMessages(session);
  renderUsage(session);
  void ensureHistory(session.id);
  renderHistoryMore(session.id);
  renderEvents();
  renderQuickNav();
}

// A conversation longer than one page keeps its oldest page one tap away. The
// control lives above the log so prepending earlier entries never hides it, and
// it is hidden entirely once the computer reports nothing precedes the page.
function renderHistoryMore(sessionId) {
  const control = $("#history-more");
  const meta = model.historyMeta.get(sessionId);
  const loading = model.historyLoading === sessionId;
  control.hidden = !sessionId || (!loading && meta?.hasMore !== true);
  const button = $("#load-earlier");
  button.disabled = loading;
  button.querySelector("span").textContent = loading ? "正在加载…" : "加载更早";
}

async function loadEarlierHistory() {
  const sessionId = model.selectedId;
  if (!sessionId || model.historyLoading) return;
  const meta = model.historyMeta.get(sessionId);
  if (!meta?.oldestSeq) return;
  model.historyLoading = sessionId;
  renderHistoryMore(sessionId);
  const log = $("#event-log");
  const heightBefore = log.scrollHeight;
  const scrollBefore = log.scrollTop;
  try {
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/history?limit=${HISTORY_LIMIT}&before=${meta.oldestSeq}`);
    const added = mergeHistory(model.events, model.deltaEvents, page.events, model.eventIds);
    model.historyMeta.set(sessionId, {
      oldestSeq: page.oldestSeq ?? meta.oldestSeq,
      hasMore: page.hasMore === true,
    });
    if (trimEvents(model.events, model.deltaEvents, { keepSessionId: sessionId })) {
      model.eventIds = new Set(model.events.map((event) => event.eventId).filter(Boolean));
    }
    if (!added) toast("没有更早的记录了");
    renderHistoryMore(sessionId);
    renderEvents();
    // Keep the reader on the same line: the earlier page lands above it, so the
    // scroll offset grows by exactly the height that was inserted.
    log.scrollTop = scrollBefore + (log.scrollHeight - heightBefore);
  } catch (error) {
    toast(`加载更早失败：${error.message}`);
  } finally {
    model.historyLoading = null;
    renderHistoryMore(sessionId);
  }
}

let renderedEntries = [];

// Entries are append-only except for the reply that is still streaming, so the
// DOM is diffed by key: unchanged entries are never touched, and only the
// growing reply is rewritten. Rebuilding all of innerHTML per event was the
// main reason a long conversation felt frozen on a phone.
function applyEntries(log, entries) {
  if (!entries.length) {
    if (log.childElementCount === 0 || renderedEntries.length) log.innerHTML = LOG_EMPTY_STATE;
    renderedEntries = [];
    return;
  }

  let common = 0;
  while (common < renderedEntries.length && common < entries.length && renderedEntries[common].key === entries[common].key) common += 1;

  if (common === entries.length && common === renderedEntries.length && common > 0) {
    const node = log.children[common - 1];
    if (node && node.lastEntryHtml !== entries[common - 1].html) {
      node.lastEntryHtml = entries[common - 1].html;
      node.innerHTML = entries[common - 1].html;
    }
    renderedEntries = entries;
    return;
  }

  const children = [...log.children];
  for (let index = common; index < children.length; index += 1) children[index].remove();
  const fragment = document.createDocumentFragment();
  for (let index = common; index < entries.length; index += 1) {
    const node = document.createElement("article");
    node.className = `event-entry ${entries[index].className}`.trim();
    node.dataset.entryKey = entries[index].key;
    node.lastEntryHtml = entries[index].html;
    node.innerHTML = entries[index].html;
    fragment.append(node);
  }
  log.append(fragment);
  renderedEntries = entries;
}

function renderEvents() {
  const log = $("#event-log");
  const followsTail = !log.childElementCount || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const relevant = model.events.filter((event) => event.sessionId === model.selectedId);
  if (!relevant.length && model.selectedId) {
    // "准备好了" is only true for a conversation with nothing in it. While its
    // history is being fetched, or when the computer has nothing to show, saying
    // so is what stops an empty log from reading as a failed load.
    const status = model.historyStatus.get(model.selectedId);
    log.innerHTML = status === "loading" ? LOG_LOADING_STATE : LOG_NO_HISTORY_STATE;
    renderedEntries = [];
    renderQuickNav();
    return;
  }
  applyEntries(log, buildEntries(relevant, { statusLabel: eventStatusLabel, math: model.mathRenderer }));
  // Formulas start as escaped TeX placeholders; the typesetting engine is fetched
  // only once a message actually contains one, so a conversation without math
  // never pays for it.
  if (!model.mathRenderer && !model.katexPromise && log.querySelector(".math-tex")) void enableMathRendering();
  if (followsTail) log.scrollTop = log.scrollHeight;
  renderQuickNav();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

async function refreshState() {
  model.state = await api("/api/state");
  renderState();
}

function connectEvents() {
  model.stream?.close();
  setConnection("", "正在连接");
  // No explicit `after` cursor: the browser resends the last event id it saw, so
  // an automatic reconnect resumes from where it stopped. Pinning `after=0` in
  // the URL made every reconnect replay the whole buffered history, which is why
  // the transcript used to crawl back in over the tunnel.
  const stream = new EventSource("/api/events");
  model.stream = stream;
  stream.addEventListener("open", () => setConnection("online", "实时同步"));
  stream.addEventListener("error", () => setConnection("offline", "正在重连"));
  stream.addEventListener("agent-event", (message) => {
    const event = JSON.parse(message.data);
    if (event.seq <= model.lastSeq) return;
    model.lastSeq = event.seq;
    // A conversation whose history was fetched before the stream connected is
    // replayed again by the server; without this the whole transcript rendered
    // twice.
    if (event.eventId && model.eventIds.has(event.eventId)) return;
    if (event.eventId) model.eventIds.add(event.eventId);
    absorbEvent(model.events, model.deltaEvents, event);
    // Announce only completed messages and recognized status changes; deltas
    // and tool chatter would spam the polite live region on every token.
    if (event.kind === "message.completed") {
      $("#event-announcer").textContent = `${event.payload.role === "user" ? "你" : "Agent"}：${String(event.payload.text ?? "").slice(0, 180)}`;
    } else if (event.kind === "approval.requested") {
      $("#event-announcer").textContent = "收到一条需要批准的请求";
    } else if (event.kind !== "message.delta") {
      const label = eventStatusLabel(event.kind);
      if (label !== event.kind) $("#event-announcer").textContent = label;
    }
    if (trimEvents(model.events, model.deltaEvents, { keepSessionId: model.selectedId })) {
      model.eventIds = new Set(model.events.map((entry) => entry.eventId).filter(Boolean));
    }
    const session = model.state.sessions.find((item) => item.id === event.sessionId);
    if (session) {
      if (event.kind === "turn.started") session.status = "running";
      if (event.kind === "turn.completed" || event.kind === "turn.cancelled") session.status = "ready";
      if (event.kind === "turn.failed") session.status = "failed";
      if (event.kind === "control.granted") session.controller = event.payload.controller;
      if (event.kind === "model.changed" && session.modelDirectory) session.modelDirectory.current = event.payload.selected;
      if (event.kind === "approval.policy") session.autoApprove = event.payload.autoApprove ?? null;
    }
    if (event.kind.startsWith("session.") || event.kind === "conversation.discovered") void refreshState().catch((error) => toast(error.message));
    else scheduleRender();
  });
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  const attachments = model.pendingAttachments.map((attachment) => attachment.id);
  // An image on its own is a complete message ("what is wrong here?").
  if ((!text && !attachments.length) || !model.selectedId) return;
  input.value = "";
  input.style.height = "auto";
  try {
    const result = await api(`/api/sessions/${model.selectedId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}), commandId: commandId() }),
    });
    model.pendingAttachments = [];
    renderPendingAttachments();
    if (result?.queued) {
      toast(`Agent 正在忙，已排队（第 ${result.position} 位）`);
      await refreshState();
    }
    await rememberSession();
  } catch (error) {
    input.value = text;
    toast(error.message);
  }
});

$("#message-input").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 320)}px`;
});

$("#take-control").addEventListener("click", async () => {
  try {
    await api(`/api/sessions/${model.selectedId}/control`, { method: "POST", body: JSON.stringify({ commandId: commandId(), force: true }) });
    await rememberSession();
    await refreshState();
  } catch (error) { toast(error.message); }
});

$("#model-select").addEventListener("change", () => {
  renderReasoningOptions(currentSession()?.modelDirectory);
});

$("#apply-model").addEventListener("click", async () => {
  const session = currentSession();
  const selected = selectedSessionModel();
  if (!session || !selected) return;
  const button = $("#apply-model");
  button.disabled = true;
  try {
    const result = await api(`/api/sessions/${session.id}/model`, {
      method: "POST",
      body: JSON.stringify({
        ...selected,
        ...( $("#reasoning-select").value ? { reasoningEffort: $("#reasoning-select").value } : {}),
        commandId: commandId(),
      }),
    });
    if (session.modelDirectory) session.modelDirectory.current = result.selected;
    await refreshState();
    toast(`已切换到 ${result.selected.model}`);
  } catch (error) { toast(error.message); }
  finally { renderSession(); }
});

$("#stop-session").addEventListener("click", async () => {
  const button = $("#stop-session");
  if (Date.now() > model.stopConfirmUntil) {
    model.stopConfirmUntil = Date.now() + 5000;
    button.classList.add("confirming");
    button.querySelector("span").textContent = "再次点击确认";
    setTimeout(() => {
      if (Date.now() > model.stopConfirmUntil) {
        button.classList.remove("confirming");
        button.querySelector("span").textContent = "停止";
      }
    }, 5100);
    return;
  }
  model.stopConfirmUntil = 0;
  button.classList.remove("confirming");
  button.querySelector("span").textContent = "停止";
  try {
    await api(`/api/sessions/${model.selectedId}/stop`, { method: "POST", body: JSON.stringify({ commandId: commandId() }) });
  } catch (error) { toast(error.message); }
});

// Read the answers out of one rendered question card. Every question in the
// batch is sent, in order, with an empty selection for the ones the user left
// alone: the agent matches its pending question by position, so a partial batch
// would be refused outright.
function collectAnswers(card) {
  return [...card.querySelectorAll("[data-input-question]")].map((block) => {
    const selected = [...block.querySelectorAll("[data-input-option]")]
      .filter((input) => input.checked)
      .map((input) => input.value);
    const multi = block.dataset.inputMulti === "1";
    const custom = block.querySelector("[data-input-custom]")?.value?.trim() ?? "";
    return {
      id: block.dataset.inputQuestion,
      selected: multi ? selected : selected.slice(0, 1),
      ...(custom ? { custom } : {}),
    };
  });
}

$("#load-earlier").addEventListener("click", () => { void loadEarlierHistory(); });

$("#event-log").addEventListener("click", async (event) => {
  const toolCopy = event.target.closest("[data-copy-tool]");
  if (toolCopy) {
    try {
      await copyText(toolCopy.dataset.copyTool ?? "");
      toolCopy.textContent = "已复制";
      setTimeout(() => { toolCopy.textContent = "复制命令"; }, 1600);
    } catch {
      toast("复制失败，请长按手动选择");
    }
    return;
  }
  const copy = event.target.closest("[data-copy-code]");
  if (copy) {
    // Copy the source text, not the highlighted markup: textContent is already
    // unescaped, so what lands on the clipboard is what the agent wrote.
    const code = copy.closest(".md-code")?.querySelector("code");
    if (!code) return;
    try {
      await copyText(code.textContent ?? "");
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1600);
    } catch {
      toast("复制失败，请长按代码手动选择");
    }
    return;
  }
  const inputSubmit = event.target.closest("[data-input-submit]");
  const inputCancel = event.target.closest("[data-input-cancel]");
  if (inputSubmit || inputCancel) {
    const card = (inputSubmit ?? inputCancel).closest(".input-entry");
    const requestId = (inputSubmit ?? inputCancel).dataset[inputSubmit ? "inputSubmit" : "inputCancel"];
    if (!card || !requestId) return;
    const buttons = [...card.querySelectorAll("[data-input-submit], [data-input-cancel]")];
    for (const button of buttons) button.disabled = true;
    // Read the answers before the first attempt: a failed attempt re-renders the
    // transcript, which would detach this card.
    const answers = inputCancel ? undefined : collectAnswers(card);
    const body = inputCancel ? { cancel: true } : { answers };
    try {
      await resolveRequest(requestId, body);
      toast(inputCancel ? "已跳过这个问题" : "回答已发送");
    } catch (error) {
      for (const button of buttons) button.disabled = false;
      toast(error.message);
    }
    return;
  }
  const button = event.target.closest("[data-approval]");
  if (!button) return;
  button.disabled = true;
  try {
    // 批准同样需要控制权，走和回答提问一样的"自动接管一次"路径。
    const decide = () => api(`/api/approvals/${button.dataset.approval}`, {
      method: "POST",
      body: JSON.stringify({ commandId: commandId(), decision: button.dataset.decision }),
    });
    try {
      await decide();
    } catch (error) {
      if (error.code !== "CONTROL_REQUIRED") throw error;
      await api(`/api/sessions/${encodeURIComponent(model.selectedId)}/control`, {
        method: "POST",
        body: JSON.stringify({ commandId: commandId(), force: true }),
      });
      await decide();
      toast("已接管输入");
    }
  } catch (error) { button.disabled = false; toast(error.message); }
});

$("#rotate-pairing").addEventListener("click", async () => {
  try {
    const result = await api("/api/pairing/rotate", { method: "POST" });
    model.bootstrap.pairing = result.pairing;
    $("#pairing-url").textContent = result.pairing.url;
    $("#pairing-qr").src = `/api/pairing/qr.svg?t=${Date.now()}`;
  } catch (error) { toast(error.message); }
});

$("#notify-test").addEventListener("click", async () => {
  const button = $("#notify-test");
  button.disabled = true;
  try {
    const result = await api("/api/local/notify-test", { method: "POST" });
    toast(result.sent ? `测试通知已发送（${result.format}）` : `没有发出去：${result.reason}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#safe-shutdown").addEventListener("click", async () => {
  const button = $("#safe-shutdown");
  const label = button.querySelector("span");
  const note = $("#shutdown-note");
  if (Date.now() > model.shutdownConfirmUntil) {
    model.shutdownConfirmUntil = Date.now() + 5000;
    button.classList.add("confirming");
    label.textContent = "再次点击确认";
    note.textContent = "5 秒内再次点击，确认关闭本机 AgentBridge Node 服务。";
    setTimeout(() => {
      if (Date.now() > model.shutdownConfirmUntil && !button.disabled) {
        button.classList.remove("confirming");
        label.textContent = "安全停止";
        note.textContent = "仅关闭 AgentBridge Node 服务，不会关闭 Cloudflare 或 ZeroTier。运行中的任务会阻止关闭。";
      }
    }, 5100);
    return;
  }

  model.shutdownConfirmUntil = 0;
  button.classList.remove("confirming");
  button.disabled = true;
  label.textContent = "正在安全停止…";
  note.textContent = "正在释放 Agent 连接并停止接受新请求，请稍候。";
  try {
    await api("/api/local/shutdown", { method: "POST", body: "{}" });
    model.stream?.close();
    model.stream = null;
    setConnection("offline", "已停止");
    label.textContent = "AgentBridge 已停止";
    note.textContent = "Node 服务已收到安全停止指令。可关闭此页面；重新使用时请在电脑上运行启动器。";
  } catch (error) {
    button.disabled = false;
    label.textContent = "安全停止";
    if (error.code === "ACTIVE_SESSIONS") {
      const count = error.diagnostics?.count ?? 1;
      note.textContent = `仍有 ${count} 个 Agent 任务运行中。请先在对应会话点击“停止”，确认结束后再关闭 Bridge。`;
    } else {
      note.textContent = `停止失败：${error.message}`;
    }
    toast(error.message);
  }
});

// The return strip is one line on a phone so the conversation starts higher; the
// full instructions stay one tap away and the choice is remembered.
const RETURN_DETAILS_KEY = "agentbridge.return.details";

function applyReturnDetails(expanded) {
  const entry = $("#return-entry");
  const toggle = $("#toggle-return-details");
  if (!entry || !toggle) return;
  entry.classList.toggle("expanded", expanded);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.textContent = expanded ? "收起" : "详情";
}

$("#toggle-return-details").addEventListener("click", () => {
  const expanded = !$("#return-entry").classList.contains("expanded");
  applyReturnDetails(expanded);
  try {
    localStorage.setItem(RETURN_DETAILS_KEY, expanded ? "1" : "0");
  } catch {
    // Storage may be unavailable in private browsing; the state simply resets.
  }
});
$("#copy-return-url").addEventListener("click", async () => {
  await copyText(returnUrl());
  toast("入口已复制；也可在微信右上角“…”中收藏本页。");
});

$("#access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("#access-key-input").value.trim();
  if (!key) return;
  try {
    await api("/api/access", { method: "POST", body: JSON.stringify({ key }) });
    location.reload();
  } catch (error) {
    $("#access-message").textContent = `${error.message}。请核对后重试。`;
  }
});

// ---------- 抽屉交互 ----------
// A wide window keeps the drawer as a permanent sidebar, so closing it there would
// hide the only navigation the console has.
function drawerIsPermanent() {
  return window.matchMedia("(min-width: 781px)").matches;
}

function selectDrawerSession(sessionId) {
  if (!sessionId) return;
  model.selectedId = sessionId;
  const navigation = resolveWorkspaceNavigation({
    workspaces: model.state?.workspaces ?? [],
    sessions: model.state?.sessions ?? [],
    selectedWorkspaceId: model.selectedWorkspaceId,
    selectedSessionId: sessionId,
  });
  model.selectedWorkspaceId = navigation.workspaceId;
  model.selectedId = navigation.sessionId;
  model.sessionSignature = "";
  renderState();
  void rememberSession(sessionId).catch((error) => toast(error.message));
  setDrawerOpen(false);
}

$("#drawer-toggle").addEventListener("click", () => setDrawerOpen(true));
$("#drawer-close").addEventListener("click", () => setDrawerOpen(false));
$("#drawer-mask").addEventListener("click", () => setDrawerOpen(false));

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !model.drawer.open) return;
  event.preventDefault();
  setDrawerOpen(false);
});

$("#drawer-query").addEventListener("input", (event) => {
  model.drawer.query = event.target.value;
  renderDrawer();
  scheduleDeepSearch(model.drawer.query);
});

function scheduleDeepSearch(query) {
  if (model.deepSearchTimer) clearTimeout(model.deepSearchTimer);
  const trimmed = String(query ?? "").trim();
  if (trimmed.length < 2) {
    model.deepSearch = { query: "", loading: false, hits: [], error: "", truncated: false };
    renderDeepSearch();
    return;
  }
  model.deepSearch = { ...model.deepSearch, query: trimmed, loading: true, error: "" };
  renderDeepSearch();
  model.deepSearchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/search?q=${encodeURIComponent(trimmed)}&limit=30`);
      if (model.deepSearch.query !== trimmed) return;
      model.deepSearch = { query: trimmed, loading: false, hits: result.hits ?? [], error: "", truncated: Boolean(result.truncated) };
    } catch (error) {
      if (model.deepSearch.query !== trimmed) return;
      model.deepSearch = { query: trimmed, loading: false, hits: [], error: error.message, truncated: false };
    }
    renderDeepSearch();
  }, 260);
}

function renderDeepSearch() {
  const target = $("#drawer-deep-search");
  if (!target) return;
  const state = model.deepSearch;
  if (!state.query) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }
  target.hidden = false;
  if (state.loading) {
    target.innerHTML = `<p class="drawer-deep-status">正在所有会话中搜索「${escapeHtml(state.query)}」…</p>`;
    return;
  }
  if (state.error) {
    target.innerHTML = `<p class="drawer-deep-status">搜索失败：${escapeHtml(state.error)}</p>`;
    return;
  }
  if (!state.hits.length) {
    target.innerHTML = `<p class="drawer-deep-status">所有会话里都没有提到「${escapeHtml(state.query)}」。</p>`;
    return;
  }
  const rows = state.hits.map((hit) => {
    const when = hit.at ? new Date(hit.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const role = hit.role === "user" ? "你" : hit.role === "tool" ? "工具" : "Agent";
    return `<button class="drawer-deep-hit" type="button" data-deep-session="${escapeHtml(hit.sessionId)}">
      <span class="drawer-deep-title">${escapeHtml(hit.sessionTitle ?? "未命名会话")}<em>${escapeHtml(role)} · ${escapeHtml(when)}</em></span>
      <span class="drawer-deep-snippet">${escapeHtml(hit.snippet)}</span>
    </button>`;
  }).join("");
  target.innerHTML = `<p class="drawer-deep-head">在对话内容里找到 ${state.hits.length} 处${state.truncated ? "（日志过长，只搜了最近部分）" : ""}</p>${rows}`;
}

$("#drawer-deep-search")?.addEventListener("click", (event) => {
  const hit = event.target.closest("[data-deep-session]");
  if (!hit) return;
  selectDrawerSession(hit.dataset.deepSession);
});

$("#drawer-tree").addEventListener("click", (event) => {
  const agent = event.target.closest("[data-agent]");
  if (agent) {
    toggleDrawerExpansion("agent", agent.dataset.agent);
    return;
  }
  const project = event.target.closest("[data-project]");
  if (project) {
    toggleDrawerExpansion("project", project.dataset.project);
    return;
  }
  const session = event.target.closest("[data-session]");
  if (session) selectDrawerSession(session.dataset.session);
});

// A left swipe is the expected way to dismiss a drawer on a phone.
(() => {
  let startX = null;
  let startY = null;
  const drawer = $("#agent-drawer");
  drawer.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });
  drawer.addEventListener("touchend", (event) => {
    if (startX === null) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    startX = null;
    startY = null;
    if (dx < -60 && dy < 40) setDrawerOpen(false);
  }, { passive: true });
})();

// "刷新状态" re-reads the catalog; it is the only footer action that can change
// what the tree shows without leaving the drawer.
// ---------- 会话创建与历史同步（抽屉驱动） ----------
async function createSession({ adapterId, projectAlias, title }) {
  const button = $("#create-form").querySelector("button[type=submit]");
  const label = button.textContent;
  button.disabled = true;
  // A DSH Desktop conversation is opened inside the desktop app, so say so instead
  // of implying this process is starting an Agent.
  button.textContent = adapterId === "deepseek-harness-desktop" ? "正在桌面端创建…" : "正在启动…";
  try {
    const result = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        adapterId,
        projectAlias,
        ...(title ? { title } : {}),
        commandId: commandId(),
      }),
    });
    model.selectedId = result.session.id;
    closeCreateSheet();
    setDrawerOpen(false);
    await rememberSession(result.session.id);
    await refreshState();
    toast("会话已创建");
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    button.textContent = label;
    syncCreateAdapterNote();
  }
}

// Which Agent reads which project is the user's call, not a guess: the sheet lists
// only Agents that can actually publish a conversation list.
async function syncHistory({ adapterId, workspaceId } = {}) {
  const adapter = (model.state?.adapters ?? []).find((entry) => entry.id === adapterId);
  const workspace = (model.state?.workspaces ?? []).find((entry) => entry.id === workspaceId && entry.enabled !== false);
  if (!adapter || !workspace) {
    toast("请选择要同步的 Agent 与项目");
    return false;
  }
  if (model.discoveryLoading) return false;
  model.discoveryLoading = true;
  renderDrawer();
  toast(`正在读取 ${adapter.label} 在「${workspace.name}」的公开会话列表…`);
  try {
    const result = await api(`/api/conversations?workspaceId=${encodeURIComponent(workspace.id)}&adapterId=${encodeURIComponent(adapter.id)}&refresh=1`);
    toast(result.discovery.created || result.discovery.updated
      ? `同步完成：新增 ${result.discovery.created} 个，更新 ${result.discovery.updated} 个会话。`
      : "已是最新，没有发现新的会话。");
    await refreshState();
    return true;
  } catch (error) {
    toast(`同步失败：${error.message}`);
    return false;
  } finally {
    model.discoveryLoading = false;
    renderDrawer();
  }
}

function openSyncSheet() {
  const adapters = discoverableAdapters(model.state?.adapters ?? []);
  const projects = (model.state?.workspaces ?? []).filter((workspace) => workspace.enabled !== false);
  if (!adapters.length || !projects.length) {
    toast("当前没有可公开同步历史的 Agent");
    return;
  }
  $("#sync-adapter").innerHTML = adapters
    .map((adapter) => `<option value="${escapeHtml(adapter.id)}">${escapeHtml(adapter.label)}</option>`)
    .join("");
  $("#sync-project").innerHTML = projects
    .map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.name)}</option>`)
    .join("");
  // Sensible defaults, still changeable: the conversation in view decides the
  // project, and the first Agent that can publish a list is the common case.
  const session = currentSession();
  const sessionWorkspace = (model.state?.workspaces ?? []).find((workspace) => workspace.alias === session?.projectAlias)
    ?? currentWorkspace();
  if (sessionWorkspace) $("#sync-project").value = sessionWorkspace.id;
  syncAdapterNote();
  const sheet = $("#sync-sheet");
  sheet.removeAttribute("inert");
  sheet.classList.add("open");
  $("#sync-mask").hidden = false;
  $("#sync-adapter").focus({ preventScroll: true });
}

function closeSyncSheet() {
  const sheet = $("#sync-sheet");
  sheet.classList.remove("open");
  sheet.setAttribute("inert", "");
  $("#sync-mask").hidden = true;
  $("#drawer-discover").focus({ preventScroll: true });
}

function syncAdapterNote() {
  const adapter = (model.state?.adapters ?? []).find((entry) => entry.id === $("#sync-adapter").value);
  $("#sync-adapter-note").textContent = adapter
    ? `${adapter.label}：只登记它能公开列举的历史会话，不读取私有转写文件，也不会启动对话。`
    : "";
}
$("#drawer-refresh").addEventListener("click", async () => {
  const button = $("#drawer-refresh");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await refreshState();
    toast("状态已刷新");
  } catch (error) {
    toast(`刷新失败：${error.message}`);
  }
  button.disabled = false;
});

$("#drawer-discover").addEventListener("click", () => {
  setDrawerOpen(false);
  openSyncSheet();
});
$("#sync-close").addEventListener("click", () => closeSyncSheet());
$("#sync-mask").addEventListener("click", () => closeSyncSheet());
$("#sync-adapter").addEventListener("change", () => syncAdapterNote());
$("#sync-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const adapterId = $("#sync-adapter").value;
  const workspaceId = $("#sync-project").value;
  closeSyncSheet();
  await syncHistory({ adapterId, workspaceId });
});

// ---------- 新建会话（抽屉头部 ＋） ----------
// Creating a conversation starts by choosing an Agent, so the picker shows every
// Agent with its real capability: an attach-only or missing tool stays listed and
// disabled with the reason, instead of vanishing from the list.
function openCreateSheet() {
  const adapters = model.state?.adapters ?? [];
  const picker = $("#create-adapter");
  picker.innerHTML = adapters.map((adapter) => {
    const creation = adapterCreationPresentation(adapter);
    return `<option value="${escapeHtml(adapter.id)}"${creation.selectable ? "" : " disabled"}>${escapeHtml(adapter.label + creation.suffix)}</option>`;
  }).join("");
  const firstUsable = adapters.find((adapter) => adapterCreationPresentation(adapter).selectable);
  if (firstUsable) picker.value = firstUsable.id;
  const projects = (model.state?.workspaces ?? []).filter((workspace) => workspace.enabled !== false);
  $("#create-project").innerHTML = projects
    .map((workspace) => `<option value="${escapeHtml(workspace.alias)}">${escapeHtml(workspace.name)}</option>`)
    .join("");
  $("#create-title-input").value = "";
  syncCreateAdapterNote();
  const sheet = $("#create-sheet");
  sheet.removeAttribute("inert");
  sheet.classList.add("open");
  $("#create-mask").hidden = false;
  $("#create-adapter").focus({ preventScroll: true });
}

function closeCreateSheet() {
  const sheet = $("#create-sheet");
  sheet.classList.remove("open");
  sheet.setAttribute("inert", "");
  $("#create-mask").hidden = true;
  $("#drawer-create").focus({ preventScroll: true });
}

function syncCreateAdapterNote() {
  const adapter = model.state?.adapters.find((item) => item.id === $("#create-adapter").value);
  const creation = adapter ? adapterCreationPresentation(adapter) : { enabled: false };
  const submit = $("#create-form").querySelector("button[type=submit]");
  $("#create-adapter-note").textContent = creation.blocked
    ? creation.blocked === "桌面端离线"
      ? "这个 Agent 的会话由桌面端创建：先在 DSH Desktop 的对话里运行 /phone，再回来新建。"
      : `这个 Agent 现在不能新建：${creation.blocked}。`
    : adapter?.availability?.note
      ?? (creation.enabled ? "会话会在所选项目目录中启动。" : "这个 Agent 不能从手机新建会话。");
  submit.disabled = !creation.enabled;
  submit.textContent = creation.enabled ? "创建会话" : "此 Agent 不能新建";
}

$("#drawer-create").addEventListener("click", () => {
  if (!model.state) return;
  openCreateSheet();
});
$("#create-close").addEventListener("click", () => closeCreateSheet());
$("#create-mask").addEventListener("click", () => closeCreateSheet());
$("#create-adapter").addEventListener("change", () => syncCreateAdapterNote());

$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const adapterId = $("#create-adapter").value;
  const projectAlias = $("#create-project").value;
  const title = $("#create-title-input").value.trim();
  if (!adapterId || !projectAlias) return;
  void createSession({ adapterId, projectAlias, title });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("#create-sheet").hidden || !$("#create-sheet").classList.contains("open")) return;
  event.preventDefault();
  closeCreateSheet();
});

async function init() {
  await storeAccessKeyFromUrl();
  const pairingResult = await pairFromUrl().catch((error) => {
    if (/Access key/.test(error.message)) {
      showAccessScreen("此实例已开启公网保护。请重新扫描电脑上的二维码，或输入启动器窗口中显示的访问密钥。");
    }
    return null;
  });
  if (pairingResult === null) return;
  model.state = await ensureSession();
  const requestedSessionId = pairingResult.targetSessionId
    || new URLSearchParams(location.search).get("session")
    || model.state.device.lastSessionId;
  if (requestedSessionId && model.state.sessions.some((session) => session.id === requestedSessionId)) {
    model.selectedId = requestedSessionId;
  }
  model.lastSeq = 0;
  model.events = [];
  model.eventIds = new Set();
  indexDeltas(model.events, model.deltaEvents);
  renderedEntries = [];
  model.sessionSignature = "";
  model.workspaceSignature = "";
  await loadBootstrap();
  renderReturnEntry();
  $("#pairing-screen").hidden = true;
  $("#app").hidden = false;
  // The drawer is the navigation on every width: wide screens keep it open as a
  // sidebar (which is what the body class reserves space for), phones start with
  // it closed so the conversation keeps the whole screen.
  document.body.classList.add("has-drawer");
  setDrawerOpen(drawerIsPermanent());
  renderState();
  connectEvents();
}

init().catch((error) => {
  if (/Access key/.test(error.message)) {
    showAccessScreen("此实例已开启公网保护。请重新扫描电脑上的二维码，或输入启动器窗口中显示的访问密钥。");
    return;
  }
  $("#pairing-screen").hidden = false;
  $("#pairing-message").textContent = error.message;
  $(".loader").hidden = true;
});

// ---- 自动放行（限时批量批准） ----
// The countdown is the honest part of this feature: a blanket approval must show
// how much of its window is left, and must be one tap away from being cancelled.

function formatRemaining(until) {
  const seconds = Math.max(0, Math.round((until - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderAutoApprove(session) {
  const toggle = $("#auto-approve-toggle");
  const panel = $("#auto-approve-panel");
  const pill = $("#auto-approve-off");
  const policy = session?.autoApprove ?? null;
  const supported = Boolean(session) && (model.state?.adapters ?? [])
    .some((adapter) => adapter.id === session.adapterId && adapter.capabilities?.approve !== false);
  toggle.hidden = !supported;
  if (!supported) {
    panel.hidden = true;
    pill.hidden = true;
    if (model.autoApproveTimer) {
      clearInterval(model.autoApproveTimer);
      model.autoApproveTimer = null;
    }
    return;
  }
  if (policy) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    pill.hidden = false;
    const scope = policy.tools?.includes("*") ? "全部工具" : (policy.tools ?? []).join("、");
    pill.textContent = `自动放行 ${formatRemaining(policy.until)} · ${scope} ✕`;
    pill.title = "点击立即取消自动放行";
    if (!model.autoApproveTimer) {
      model.autoApproveTimer = setInterval(() => {
        const current = currentSession();
        if (!current?.autoApprove) {
          clearInterval(model.autoApproveTimer);
          model.autoApproveTimer = null;
          renderAutoApprove(currentSession());
          return;
        }
        pill.textContent = `自动放行 ${formatRemaining(current.autoApprove.until)} · ${current.autoApprove.tools?.includes("*") ? "全部工具" : current.autoApprove.tools.join("、")} ✕`;
      }, 1000);
    }
    return;
  }
  pill.hidden = true;
  if (model.autoApproveTimer) {
    clearInterval(model.autoApproveTimer);
    model.autoApproveTimer = null;
  }
}

function closeAutoApprovePanel() {
  $("#auto-approve-panel").hidden = true;
  $("#auto-approve-toggle").setAttribute("aria-expanded", "false");
  renderQuickNav();
}

async function submitAutoApprove(minutes) {
  if (!model.selectedId) return;
  const tools = $("#auto-approve-all").checked ? ["*"] : ["shell"];
  try {
    const result = await api(`/api/sessions/${model.selectedId}/auto-approve`, {
      method: "POST",
      body: JSON.stringify({ minutes, tools, commandId: commandId() }),
    });
    const session = currentSession();
    if (session) session.autoApprove = result.autoApprove ?? null;
    closeAutoApprovePanel();
    renderAutoApprove(session);
    renderQueuedMessages(session);
    renderUsage(session);
    toast(result.autoApprove
      ? `已放行 ${minutes} 分钟（${tools.includes("*") ? "全部工具" : tools.join("、")}）`
      : "已取消自动放行");
  } catch (error) {
    toast(error.message);
  }
}

$("#auto-approve-toggle").addEventListener("click", () => {
  const panel = $("#auto-approve-panel");
  const toggle = $("#auto-approve-toggle");
  const open = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) placePopover(panel, toggle);
  renderQuickNav();
});

$("#auto-approve-arm").addEventListener("click", async () => {
  const chosen = document.querySelector('input[name="auto-approve-minutes"]:checked');
  await submitAutoApprove(Number(chosen?.value ?? 10));
});

$("#auto-approve-off").addEventListener("click", async () => {
  await submitAutoApprove(0);
});
// ---- 附件：拍照/截图/文件直接发给 Agent ----
// Uploads go out as raw bytes (no base64 inflation, no multipart parser on the
// server) and are only attached to the message when the user actually sends it.

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function renderPendingAttachments() {
  const box = $("#composer-attachments");
  if (!box) return;
  if (!model.pendingAttachments.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren(...model.pendingAttachments.map((attachment) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.dataset.attachmentId = attachment.id;
    if (attachment.isImage) {
      const image = document.createElement("img");
      image.src = attachment.previewUrl;
      image.alt = attachment.name;
      chip.append(image);
    }
    const label = document.createElement("span");
    label.className = "attachment-chip-name";
    label.textContent = `${attachment.name} · ${Math.max(1, Math.round(attachment.bytes / 1024))} KB`;
    chip.append(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-chip-remove";
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      model.pendingAttachments = model.pendingAttachments.filter((entry) => entry.id !== attachment.id);
      renderPendingAttachments();
    });
    chip.append(remove);
    return chip;
  }));
}

async function uploadAttachment(file) {
  if (!model.selectedId) return null;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast(`${file.name} 超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB，没有上传`);
    return null;
  }
  const response = await fetch(`/api/sessions/${model.selectedId}/attachments`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-attachment-name": encodeURIComponent(file.name || "attachment"),
    },
    body: file,
  });
  const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error ?? `上传失败 (${response.status})`);
  return body.attachment;
}

$("#attach-button").addEventListener("click", () => $("#attach-input").click());

$("#attach-input").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  event.target.value = "";
  if (!files.length) return;
  const button = $("#attach-button");
  button.disabled = true;
  try {
    for (const file of files.slice(0, 6)) {
      const attachment = await uploadAttachment(file);
      if (attachment) model.pendingAttachments.push(attachment);
    }
    renderPendingAttachments();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
// ---- 排队中的消息 ----
// A busy agent used to answer 409. Now the server queues the message, so the phone
// shows what is waiting and lets you take it back before it is sent.

function renderQueuedMessages(session) {
  const box = $("#composer-queue");
  if (!box) return;
  const queued = session?.queued ?? [];
  if (!queued.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren(...queued.map((entry) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    row.dataset.queueId = entry.commandId;
    const label = document.createElement("span");
    label.textContent = `第 ${entry.position} 位 · ${entry.text || "（附件）"}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "撤回";
    cancel.addEventListener("click", async () => {
      if (!model.selectedId) return;
      try {
        await api(`/api/sessions/${model.selectedId}/queue/cancel`, {
          method: "POST",
          body: JSON.stringify({ commandId: entry.commandId }),
        });
        const current = currentSession();
        if (current) current.queued = current.queued.filter((item) => item.commandId !== entry.commandId);
        renderQueuedMessages(currentSession());
        toast("已撤回排队消息");
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(label, cancel);
    return row;
  }));
}

// ---- 语音输入 ----
// Only shown when the engine exists: a phone without Web Speech keeps the plain
// keyboard instead of a button that cannot work.

const SpeechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
let recognition = null;

function stopVoiceInput() {
  recognition?.stop();
  recognition = null;
  $("#voice-button").setAttribute("aria-pressed", "false");
}

if (SpeechRecognitionImpl) {
  $("#voice-button").hidden = false;
  $("#voice-button").addEventListener("click", () => {
    if (recognition) {
      stopVoiceInput();
      return;
    }
    recognition = new SpeechRecognitionImpl();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    $("#voice-button").setAttribute("aria-pressed", "true");
    const input = $("#message-input");
    const before = input.value;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      input.value = `${before}${before && !before.endsWith(" ") ? " " : ""}${transcript}`.slice(0, 20000);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    recognition.onerror = (event) => {
      stopVoiceInput();
      if (event.error !== "aborted" && event.error !== "no-speech") toast(`语音输入失败：${event.error}`);
    };
    recognition.onend = () => {
      recognition = null;
      $("#voice-button").setAttribute("aria-pressed", "false");
    };
    try {
      recognition.start();
    } catch (error) {
      stopVoiceInput();
      toast(`语音输入无法启动：${error.message}`);
    }
  });
}
// ---- 用量：轮次、工具调用与（有则显示）token ----
// Turns and tool calls are always known; tokens appear only when the agent reports
// them, so the line never claims a number it does not have.

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function renderUsage(session) {
  const line = $("#usage-line");
  if (!line) return;
  const usage = session?.usage;
  if (!usage || (!usage.turns && !usage.toolCalls)) {
    line.hidden = true;
    line.textContent = "";
    return;
  }
  const parts = [`${usage.turns ?? 0} 轮对话`];
  if (usage.toolCalls) parts.push(`${usage.toolCalls} 次工具`);
  const input = formatTokens(usage.inputTokens);
  const output = formatTokens(usage.outputTokens);
  if (input || output) parts.push(`${input || "0"} → ${output || "0"} tokens`);
  line.textContent = parts.join(" · ");
  line.hidden = false;
}

function renderIntegrationStatus() {
  const row = $("#integration-row");
  const note = $("#integration-note");
  if (!row || !note) return;
  const status = model.state?.desktopIntegration;
  // "No channel at all" used to be silent, which is exactly the state a bridge restart
  // leaves behind: every DSH Desktop conversation in the drawer, none of them drivable.
  const hasDesktopSessions = (model.state?.sessions ?? []).some((item) => item.adapterId === "deepseek-harness-desktop");
  if (!status?.paired) {
    row.hidden = !hasDesktopSessions;
    note.textContent = hasDesktopSessions
      ? "桌面端还没连上：在电脑上的 DSH Desktop 会话里执行 /phone；桌面端在跑新版集成时会自己接回。"
      : "";
    return;
  }
  row.hidden = false;
  note.textContent = status.stale
    ? `桌面端集成是旧版（v${status.version}，需要 v${status.required}）：运行 npm run install:dsh-phone 并重启 DSH Desktop，否则新功能不会出现。`
    : `已连接，版本 v${status.version}。`;
}
// ---- 手机端的通知开关 ----
// Muting is per bridge and persisted in .agentbridge/notify.json, so the switch keeps
// its position across restarts and does not depend on how the bridge was launched.

async function setNotificationsMuted(muted) {
  const result = await api("/api/notifications", { method: "POST", body: JSON.stringify({ muted }) });
  if (model.state) model.state.notifications = result.notifications;
  renderDrawerNotifications();
  renderNotifications();
  toast(muted ? "已静音：不再推送通知" : "已开启：Agent 需要你时会推送");
}

function renderDrawerNotifications() {
  const row = document.querySelector(".drawer-card");
  const toggle = $("#drawer-notify-toggle");
  const note = $("#drawer-notify-note");
  if (!row || !toggle || !note) return;
  const notifications = model.state?.notifications;
  if (!notifications?.enabled) {
    // Nothing configured: say so once, without a switch that would do nothing.
    row.hidden = false;
    note.textContent = "未配置：在 .agentbridge/notify.json 里填写 webhook 后即可开启";
    toggle.hidden = true;
    return;
  }
  row.hidden = false;
  toggle.hidden = false;
  const channel = notifications.channel ? ` · ${notifications.channel}` : "";
  note.textContent = notifications.muted
    ? `静音中（${notifications.format}${channel}）`
    : `推送中（${notifications.format}${channel}）`;
  toggle.textContent = notifications.muted ? "开启" : "静音";
  toggle.setAttribute("aria-pressed", String(Boolean(notifications.muted)));
}

$("#drawer-notify-toggle")?.addEventListener("click", async () => {
  const muted = Boolean(model.state?.notifications?.muted);
  const button = $("#drawer-notify-toggle");
  button.disabled = true;
  try {
    await setNotificationsMuted(!muted);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
// ---- 玻璃选择器：原生 select 仍是状态来源，弹层与全站弹层共用一套配方 ----
// Why a custom panel at all: a native <select> popup is drawn by the OS, so it can
// never match the glass language. The value still lives in the real <select>, which is
// what renderModelControl() and the change handler already read.

const pickers = {
  model: { trigger: "#model-trigger", panel: "#model-panel", options: "#model-options", select: "#model-select", value: "#model-trigger-value", search: "#model-search" },
  reasoning: { trigger: "#reasoning-trigger", panel: "#reasoning-panel", options: "#reasoning-options", select: "#reasoning-select", value: "#reasoning-trigger-value", search: null },
};

function closePickers(except) {
  for (const [name, config] of Object.entries(pickers)) {
    if (name === except) continue;
    const panel = $(config.panel);
    const trigger = $(config.trigger);
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }
  renderQuickNav();
}

function renderPicker(name) {
  const config = pickers[name];
  const select = $(config.select);
  const trigger = $(config.trigger);
  const value = $(config.value);
  const options = $(config.options);
  if (!select || !trigger || !value || !options) return;

  const entries = [...select.options].map((option) => ({ value: option.value, label: option.textContent.trim() }));
  const current = select.selectedOptions[0];
  value.textContent = current?.textContent.trim() || "—";
  trigger.disabled = select.disabled || entries.length === 0;

  if (config.search) {
    const search = $(config.search);
    // A 240-model list is unusable without a filter; hide it for short lists.
    search.hidden = entries.length < 12;
    if (!search.hidden && !search.dataset.wired) {
      search.dataset.wired = "1";
      search.addEventListener("input", () => renderPickerOptions(name));
    }
  }
  renderPickerOptions(name);
}

function renderPickerOptions(name) {
  const config = pickers[name];
  const select = $(config.select);
  const options = $(config.options);
  if (!select || !options) return;
  const query = (config.search ? ($(config.search)?.value ?? "") : "").trim().toLowerCase();
  const rows = [...select.options]
    .map((option) => ({ value: option.value, label: option.textContent.trim(), selected: option.selected }))
    .filter((entry) => !query || entry.label.toLowerCase().includes(query));
  if (!rows.length) {
    options.innerHTML = `<p class="picker-empty">没有匹配的选项</p>`;
    return;
  }
  options.innerHTML = rows.map((entry) => `<button class="picker-option" type="button" role="option" aria-selected="${entry.selected}" data-value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</button>`).join("");
}

function togglePicker(name) {
  const config = pickers[name];
  const panel = $(config.panel);
  const trigger = $(config.trigger);
  if (!panel || !trigger || trigger.disabled) return;
  const open = panel.hidden;
  closePickers(open ? name : null);
  panel.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  if (open) {
    renderPicker(name);
    placePopover(panel, trigger);
    if (config.search && !$(config.search).hidden) $(config.search).focus({ preventScroll: true });
    else $(config.options).querySelector(".picker-option[aria-selected='true']")?.focus({ preventScroll: true });
  }
  renderQuickNav();
}

for (const [name, config] of Object.entries(pickers)) {
  $(config.trigger)?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePicker(name);
  });
  $(config.options)?.addEventListener("click", (event) => {
    const option = event.target.closest(".picker-option");
    if (!option) return;
    const select = $(config.select);
    select.value = option.dataset.value;
    // The change handler is what enables 切换模型; dispatch it exactly as a native
    // selection would, so the rest of the app needs no knowledge of this panel.
    select.dispatchEvent(new Event("change", { bubbles: true }));
    renderPicker(name);
    closePickers(null);
    $(config.trigger).focus({ preventScroll: true });
  });
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".picker")) return;
  closePickers(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = Object.entries(pickers).find(([, config]) => !$(config.panel)?.hidden);
  if (!open) return;
  event.preventDefault();
  closePickers(null);
  $(open[1].trigger)?.focus({ preventScroll: true });
});
// 自动放行面板也要"点外面/Esc 关闭"，与选择器弹层一致
(function wireAutoApproveDismissal() {
  const panel = $("#auto-approve-panel");
  const toggle = $("#auto-approve-toggle");
  if (!panel || !toggle) return;
  document.addEventListener("click", (event) => {
    if (panel.hidden) return;
    if (event.target.closest("#auto-approve-panel") || event.target.closest("#auto-approve-toggle")) return;
    closeAutoApprovePanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault();
    closeAutoApprovePanel();
    toggle.focus({ preventScroll: true });
  });
})();
// ---- 弹层定位：永远落在视口内 ----
// `position: fixed` + 打开后按视口算坐标。触发按钮可以只有 110px 宽，面板却要 320px；
// 右对齐会向左溢出，左对齐会向右溢出，所以两端都夹住，下方放不下时翻到上方。

const POPOVER_MARGIN = 8;
const POPOVER_GAP = 6;

function placePopover(panel, trigger) {
  if (!panel || !trigger) return;
  const before = trigger.getBoundingClientRect();
  if (before.top < 0 || before.bottom > window.innerHeight) {
    trigger.scrollIntoView({ block: "center", inline: "nearest" });
  }
  const rect = trigger.getBoundingClientRect();
  // Measure at a safe origin first: offsetWidth/Height need the panel to be laid out.
  panel.style.visibility = "hidden";
  panel.style.left = "0px";
  panel.style.top = "0px";
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Right-aligned to the trigger by default, then clamped to the viewport.
  const maxLeft = Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN);
  let left = rect.right - width;
  left = Math.min(Math.max(left, POPOVER_MARGIN), maxLeft);

  let top = rect.bottom + POPOVER_GAP;
  if (top + height > viewportHeight - POPOVER_MARGIN) {
    const above = rect.top - height - POPOVER_GAP;
    top = above >= POPOVER_MARGIN ? above : rect.top;
  }
  // Clamp both axes unconditionally: if the trigger itself is scrolled out of view the
  // panel still has to land inside the phone frame rather than off the page.
  const maxTop = Math.max(POPOVER_MARGIN, viewportHeight - height - POPOVER_MARGIN);
  top = Math.min(Math.max(top, POPOVER_MARGIN), maxTop);

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = "visible";
}

/** Reposition whatever is open (rotation, keyboard, scrolling). */
function repositionOpenPopovers() {
  const auto = $("#auto-approve-panel");
  if (auto && !auto.hidden) placePopover(auto, $("#auto-approve-toggle"));
  for (const config of Object.values(pickers)) {
    const panel = $(config.panel);
    if (panel && !panel.hidden) placePopover(panel, $(config.trigger));
  }
}

window.addEventListener("resize", repositionOpenPopovers);
window.addEventListener("orientationchange", repositionOpenPopovers);
// Capture phase: the transcript scrolls inside a container, and the panel should follow
// its trigger instead of drifting away from it.
window.addEventListener("scroll", repositionOpenPopovers, { passive: true, capture: true });

// ---- 快捷导航（置顶 ⇧ / 置底 ⇩）：悬浮在视口右侧，始终可点 ----
// 谁在滚要分情况：宽屏上 #event-log 自己有 max-height，是日志在滚；手机上
// 那个媒体查询把 .event-log 写成 max-height:none，于是整页在滚、日志一步不动。
// 所以两端都滚一遍（不能滚的那个是 no-op），判定端点时也同时看两者 —— 只看
// #event-log 会让手机端永远"既在顶又在底"，按钮永远处于灰掉的状态。

function pageScroller() {
  return document.scrollingElement ?? document.documentElement;
}

function scrollToTop() {
  const behavior = "smooth";
  $("#event-log")?.scrollTo?.({ top: 0, behavior });
  window.scrollTo({ top: 0, behavior });
}

function scrollToBottom() {
  const behavior = "smooth";
  const log = $("#event-log");
  if (log) log.scrollTo?.({ top: log.scrollHeight, behavior });
  window.scrollTo({ top: pageScroller().scrollHeight, behavior });
}

// 8px 容差：亚像素布局与平滑滚动收尾都会留下一点余量。
function transcriptAtTop() {
  const log = $("#event-log");
  const logAtTop = !log || log.scrollHeight - log.clientHeight <= 8 || log.scrollTop <= 8;
  return logAtTop && pageScroller().scrollTop <= 8;
}

function transcriptAtBottom() {
  const log = $("#event-log");
  const logAtBottom = !log || log.scrollHeight - log.clientHeight <= 8
    || log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const root = pageScroller();
  return logAtBottom && root.scrollHeight - root.scrollTop - root.clientHeight < 8;
}

// 到端点时只做视觉提示，绝不拦截点击：用户要求的是"始终可点"，而且
// 内容随时会因为新消息变长，把按钮变成死键没有意义。
// 弹出面板打开时把它收起来：手机上面板几乎占满宽度，悬浮键夹在旁边只是干扰。
function anyPopoverOpen() {
  return [...document.querySelectorAll(".glass-popover")].some((node) => !node.hidden);
}

function renderQuickNav() {
  const nav = $("#quick-nav");
  if (!nav) return;
  const view = $("#session-view");
  nav.hidden = view?.hidden !== false || anyPopoverOpen();
  if (nav.hidden) return;
  $("#quick-nav-top")?.classList.toggle("is-idle", transcriptAtTop());
  $("#quick-nav-bottom")?.classList.toggle("is-idle", transcriptAtBottom());
}

(function wireQuickNav() {
  const nav = $("#quick-nav");
  const topBtn = $("#quick-nav-top");
  const bottomBtn = $("#quick-nav-bottom");
  if (!nav || !topBtn || !bottomBtn) return;

  topBtn.addEventListener("click", scrollToTop);
  bottomBtn.addEventListener("click", scrollToBottom);

  // 手机上是页面在滚，所以必须监听 window；宽屏上是日志自己滚，两个都挂。
  window.addEventListener("scroll", renderQuickNav, { passive: true, capture: true });
  $("#event-log")?.addEventListener("scroll", renderQuickNav, { passive: true });
  window.addEventListener("resize", renderQuickNav);
})();