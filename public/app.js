import { createCommandId } from "/command-id.js";
import { absorbEvent, buildEntries, indexDeltas, trimEvents } from "/transcript.js";
import { adapterCreationPresentation } from "/adapter-capabilities.js";
import { discoverableAdapters, resolveWorkspaceNavigation, sessionsForWorkspace } from "/workspace-navigation.js";

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
  sessionSignature: "",
  workspaceSignature: "",
  discoveryLoading: false,
  discoveryMessage: "",
  renderTimer: null,
  deltaEvents: new Map(),
};

// The transcript is rebuilt at most this often instead of once per event. A
// streamed turn can deliver hundreds of events per second; re-rendering for
// each one is what made the phone stall while an answer was arriving.
const RENDER_INTERVAL_MS = 80;
const LOG_EMPTY_STATE = `<div class="empty-state"><div class="empty-rule"></div><h2>准备好了</h2><p>从下方发送第一条指令。真实 Agent 可能请求访问文件或运行命令。</p></div>`;

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers ?? {}) } : options.headers,
  });
  const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error ?? `请求失败 (${response.status})`);
  return body;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4200);
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

function visibleSessions() {
  return sessionsForWorkspace(model.state?.sessions ?? [], model.state?.workspaces ?? [], model.selectedWorkspaceId);
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
  $("#machine-name").textContent = model.state.machine.name;
  const navigation = resolveWorkspaceNavigation({
    workspaces: model.state.workspaces,
    sessions: model.state.sessions,
    selectedWorkspaceId: model.selectedWorkspaceId,
    selectedSessionId: model.selectedId,
  });
  model.selectedWorkspaceId = navigation.workspaceId;
  model.selectedId = navigation.sessionId;
  const workspace = currentWorkspace();
  const sessions = visibleSessions();
  $("#workspace-title").textContent = workspace?.name ?? "会话";
  $("#session-count").textContent = `${sessions.length} 个任务`;
  const adapters = model.state.adapters;
  if (!$("#adapter-select").options.length) {
    $("#adapter-select").innerHTML = adapters.map((adapter) => {
      const { selectable, suffix } = adapterCreationPresentation(adapter);
      return `<option value="${escapeHtml(adapter.id)}" ${selectable ? "" : "disabled"}>${escapeHtml(adapter.label + suffix)}</option>`;
    }).join("");
  }
  const projectOptions = model.state.workspaces.map((item) => `<option value="${escapeHtml(item.alias)}">${escapeHtml(item.name)}</option>`).join("");
  if ($("#project-select").dataset.signature !== projectOptions) {
    $("#project-select").innerHTML = projectOptions;
    $("#project-select").dataset.signature = projectOptions;
  }
  if (workspace) $("#project-select").value = workspace.alias;
  renderAdapterDetails();

  const workspaceSignature = `${model.selectedWorkspaceId}|${model.state.workspaces.map((item) => `${item.id}:${item.name}:${sessionsForWorkspace(model.state.sessions, model.state.workspaces, item.id).length}`).join("|")}`;
  if (workspaceSignature !== model.workspaceSignature) {
    model.workspaceSignature = workspaceSignature;
    const focusedWorkspaceId = document.activeElement?.closest?.("#workspace-list [data-workspace-id]")?.dataset.workspaceId ?? null;
    $("#workspace-list").innerHTML = model.state.workspaces.map((item) => {
      const count = sessionsForWorkspace(model.state.sessions, model.state.workspaces, item.id).length;
      return `<button class="workspace-row ${item.id === model.selectedWorkspaceId ? "active" : ""}" data-workspace-id="${escapeHtml(item.id)}" type="button" ${item.id === model.selectedWorkspaceId ? "aria-current=\"true\"" : ""}>
        <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.alias)}</small></span><span class="workspace-count">${count}</span>
      </button>`;
    }).join("") || `<p class="form-note">尚未登记工作区。请先从电脑端添加项目。</p>`;
    if (focusedWorkspaceId) $(`#workspace-list [data-workspace-id="${CSS.escape(focusedWorkspaceId)}"]`)?.focus();
  }

  const discoveryAdapters = discoverableAdapters(adapters);
  const discoveryButton = $("#discover-conversations");
  const discoveryAdapter = discoveryAdapters[0] ?? null;
  discoveryButton.hidden = !workspace || !discoveryAdapter;
  discoveryButton.disabled = model.discoveryLoading;
  discoveryButton.dataset.adapterId = discoveryAdapter?.id ?? "";
  discoveryButton.querySelector("span").textContent = model.discoveryLoading ? "同步中…" : "同步历史";
  $("#discovery-note").textContent = model.discoveryMessage
    || (discoveryAdapter
      ? `从 ${discoveryAdapter.label} 读取此工作区的历史会话；只登记，不会启动对话。`
      : "当前没有可公开同步历史的 Agent；仍可新建支持的会话。");

  // The session list only changes when a session is added, retitled, or changes
  // status, so it is left alone on the many events that only affect the log.
  const signature = `${model.selectedWorkspaceId}|${model.selectedId}|${sessions
    .map((session) => `${session.id}:${session.status}:${session.title}:${session.lastError ?? ""}`)
    .join("|")}`;
  if (signature !== model.sessionSignature) {
    model.sessionSignature = signature;

    // The list is rebuilt on change; restore focus to the same row so keyboard
    // and screen-reader users are not thrown back to the page top.
    const focusedSessionId = document.activeElement?.closest?.("#session-list [data-session-id]")?.dataset.sessionId ?? null;

    $("#session-list").innerHTML = sessions.map((session) => `
    <button class="session-row ${session.id === model.selectedId ? "active" : ""}" data-session-id="${escapeHtml(session.id)}" type="button" ${session.id === model.selectedId ? 'aria-current="true"' : ""}>
      <span class="status-mark ${escapeHtml(session.status)}" aria-label="${escapeHtml(statusLabel(session.status))}"></span>
      <span><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.adapterId)} · ${escapeHtml(session.projectAlias)} · ${escapeHtml(statusLabel(session.status))}</small></span>
    </button>`).join("") || `<p class="form-note">这个工作区还没有会话。可同步历史，或点击加号新建。</p>`;

    if (focusedSessionId) {
      $(`#session-list [data-session-id="${CSS.escape(focusedSessionId)}"]`)?.focus();
    }
  }

  renderSession();
}

function renderAdapterDetails() {
  const adapter = model.state?.adapters.find((item) => item.id === $("#adapter-select").value);
  const availability = adapter?.availability;
  const creation = adapterCreationPresentation(adapter);
  $("#adapter-note").textContent = availability?.note ?? "手机只能选择电脑端允许的项目。";
  const help = $("#adapter-help");
  help.hidden = !availability?.docsUrl;
  help.href = availability?.docsUrl ?? "#";
  $("#new-session-form button[type=submit]").disabled = !creation.enabled;
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
}

function renderModelControl(session, ownsControl) {
  const control = $("#model-control");
  const directory = session.modelDirectory;
  control.hidden = !directory;
  if (!directory) return;
  const isCcSwitch = directory.source === "cc-switch";
  const label = isCcSwitch ? "CC Switch 模型" : session.adapterId === "deepseek-harness-desktop" ? "DSH 模型" : session.adapterId === "codex" ? "Codex 模型" : "会话模型";
  $("#model-label").textContent = label;
  $("#model-select").setAttribute("aria-label", label);
  const select = $("#model-select");
  const choices = directory.groups.flatMap((group) => group.models.map((entry) => ({ provider: group.id, model: entry.id, label: `${group.name} · ${entry.name}` })));
  select.innerHTML = choices.map((entry) => {
    const value = JSON.stringify({ provider: entry.provider, model: entry.model });
    const selected = directory.current?.provider === entry.provider && directory.current?.model === entry.model;
    return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(entry.label)}</option>`;
  }).join("") || `<option value="">Agent 未提供可切换模型</option>`;
  renderReasoningOptions(directory);
  const isIdle = session.status !== "running";
  const enabled = choices.length > 0 && ownsControl && isIdle;
  select.disabled = !enabled;
  $("#reasoning-select").disabled = !enabled;
  $("#apply-model").disabled = !enabled;
  const failure = directory.failures?.[0]?.message;
  $("#model-note").textContent = failure
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
    const workspace = currentWorkspace();
    $("#empty-title").textContent = workspace ? `${workspace.name} 还没有会话` : "先选择一个工作区";
    $("#empty-description").textContent = workspace
      ? "点击“同步历史”读取可恢复会话，或点击加号在此工作区新建会话。"
      : "工作区只能从电脑端登记，手机不会接收任意本地路径。";
    return;
  }

  $("#session-title-heading").textContent = session.title;
  $("#session-adapter").textContent = session.adapterId;
  $("#session-project").textContent = session.projectAlias;
  const sessionError = $("#session-error");
  sessionError.hidden = !session.lastError;
  sessionError.textContent = session.lastError ? `执行失败：${session.lastError}` : "";
  const ownsControl = session.controller?.deviceId === model.state.device.id;
  const canSend = session.status !== "running" && (!session.controller || ownsControl);
  $("#control-status").textContent = ownsControl
    ? `当前由此设备控制，租约至 ${new Date(session.controller.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : session.controller ? `当前由 ${session.controller.deviceName} 控制` : "发送首条消息时自动获得控制权";
  $("#take-control").hidden = ownsControl || !session.controller;
  $("#composer").querySelector("button").disabled = !canSend;
  $("#message-input").disabled = !canSend;
  $("#message-input").placeholder = session.status === "running"
    ? "Agent 正在执行，完成后可继续…"
    : !session.controller ? "发送第一条指令并取得控制权…" : ownsControl ? "继续给 Agent 指令…" : "先接管输入再发送…";
  const stopButton = $("#stop-session");
  stopButton.hidden = session.status !== "running";
  stopButton.disabled = !ownsControl;
  stopButton.title = ownsControl ? "停止当前执行" : "只有当前控制设备可以停止执行";
  renderModelControl(session, ownsControl);
  renderEvents();
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
  applyEntries(log, buildEntries(relevant, { statusLabel: eventStatusLabel }));
  if (followsTail) log.scrollTop = log.scrollHeight;
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
    trimEvents(model.events, model.deltaEvents);
    const session = model.state.sessions.find((item) => item.id === event.sessionId);
    if (session) {
      if (event.kind === "turn.started") session.status = "running";
      if (event.kind === "turn.completed" || event.kind === "turn.cancelled") session.status = "ready";
      if (event.kind === "turn.failed") session.status = "failed";
      if (event.kind === "control.granted") session.controller = event.payload.controller;
      if (event.kind === "model.changed" && session.modelDirectory) session.modelDirectory.current = event.payload.selected;
    }
    if (event.kind.startsWith("session.") || event.kind === "conversation.discovered") void refreshState().catch((error) => toast(error.message));
    else scheduleRender();
  });
}

$("#new-session-toggle").addEventListener("click", () => {
  const form = $("#new-session-form");
  form.hidden = !form.hidden;
  $("#new-session-toggle").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) $("#adapter-select").focus();
});

$("#adapter-select").addEventListener("change", () => {
  renderAdapterDetails();
});
$("#workspace-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-workspace-id]");
  if (!row) return;
  model.selectedWorkspaceId = row.dataset.workspaceId;
  model.selectedId = null;
  model.discoveryMessage = "";
  renderedEntries = [];
  model.workspaceSignature = "";
  model.sessionSignature = "";
  renderState();
});
$("#session-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-session-id]");
  if (!row) return;
  model.selectedId = row.dataset.sessionId;
  renderState();
  void rememberSession().catch((error) => toast(error.message));
});

$("#project-select").addEventListener("change", (event) => {
  const workspace = model.state.workspaces.find((item) => item.alias === event.target.value);
  if (!workspace) return;
  model.selectedWorkspaceId = workspace.id;
  model.selectedId = null;
  model.workspaceSignature = "";
  model.sessionSignature = "";
  renderState();
});

$("#discover-conversations").addEventListener("click", async () => {
  const workspace = currentWorkspace();
  const adapterId = $("#discover-conversations").dataset.adapterId;
  if (!workspace || !adapterId || model.discoveryLoading) return;
  model.discoveryLoading = true;
  model.discoveryMessage = "正在读取公开会话列表…";
  renderState();
  try {
    const result = await api(`/api/conversations?workspaceId=${encodeURIComponent(workspace.id)}&adapterId=${encodeURIComponent(adapterId)}&refresh=1`);
    model.discoveryMessage = result.discovery.created || result.discovery.updated
      ? `同步完成：新增 ${result.discovery.created} 个，更新 ${result.discovery.updated} 个会话。`
      : "已是最新，没有发现新的会话。";
    model.selectedId = null;
    await refreshState();
  } catch (error) {
    model.discoveryMessage = `同步失败：${error.message}`;
    toast(error.message);
  } finally {
    model.discoveryLoading = false;
    renderState();
  }
});

$("#new-session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const body = Object.fromEntries(new FormData(form));
    body.commandId = commandId();
    const result = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
    model.selectedId = result.session.id;
    await rememberSession();
    form.hidden = true;
    $("#new-session-toggle").setAttribute("aria-expanded", "false");
    await refreshState();
  } catch (error) { toast(error.message); }
  finally { button.textContent = "创建会话"; renderAdapterDetails(); }
});

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text || !model.selectedId) return;
  input.value = "";
  input.style.height = "auto";
  try {
    await api(`/api/sessions/${model.selectedId}/messages`, { method: "POST", body: JSON.stringify({ text, commandId: commandId() }) });
    await rememberSession();
  } catch (error) { input.value = text; toast(error.message); }
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

$("#event-log").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approval]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/approvals/${button.dataset.approval}`, {
      method: "POST",
      body: JSON.stringify({ commandId: commandId(), decision: button.dataset.decision }),
    });
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

$("#copy-return-url").addEventListener("click", async () => {
  const value = returnUrl();
  try {
    await navigator.clipboard.writeText(value);
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
  indexDeltas(model.events, model.deltaEvents);
  renderedEntries = [];
  model.sessionSignature = "";
  model.workspaceSignature = "";
  await loadBootstrap();
  renderReturnEntry();
  $("#pairing-screen").hidden = true;
  $("#app").hidden = false;
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
