import { createCommandId } from "/command-id.js";
import { renderMessageMarkdown } from "/markdown.js";

const $ = (selector) => document.querySelector(selector);

const model = {
  state: null,
  events: [],
  selectedId: null,
  lastSeq: 0,
  stream: null,
  bootstrap: null,
  stopConfirmUntil: 0,
};

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
  $("#session-count").textContent = `${model.state.sessions.length} 个任务`;
  const adapters = model.state.adapters;
  if (!$("#adapter-select").options.length) {
    $("#adapter-select").innerHTML = adapters.map((adapter) => {
      const enabled = adapter.availability.available && adapter.availability.supported !== false;
      const selectable = enabled || adapter.availability.native;
      const suffix = enabled ? "" : adapter.availability.native ? "（原生入口）" : adapter.availability.available ? "（暂未接入）" : "（未安装）";
      return `<option value="${escapeHtml(adapter.id)}" ${selectable ? "" : "disabled"}>${escapeHtml(adapter.label + suffix)}</option>`;
    }).join("");
  }
  if (!$("#project-select").options.length) {
    $("#project-select").innerHTML = model.state.projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`).join("");
  }
  renderAdapterDetails();

  // The list is rebuilt on every event; restore focus to the same row so
  // keyboard and screen-reader users are not thrown back to the page top.
  const focusedSessionId = document.activeElement?.closest?.("#session-list [data-session-id]")?.dataset.sessionId ?? null;

  $("#session-list").innerHTML = model.state.sessions.map((session) => `
    <button class="session-row ${session.id === model.selectedId ? "active" : ""}" data-session-id="${escapeHtml(session.id)}" type="button" ${session.id === model.selectedId ? 'aria-current="true"' : ""}>
      <span class="status-mark ${escapeHtml(session.status)}" aria-label="${escapeHtml(statusLabel(session.status))}"></span>
      <span><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.adapterId)} · ${escapeHtml(session.projectAlias)} · ${escapeHtml(statusLabel(session.status))}</small></span>
    </button>`).join("") || `<p class="form-note">还没有会话。点击加号创建第一个任务。</p>`;

  if (focusedSessionId) {
    $(`#session-list [data-session-id="${CSS.escape(focusedSessionId)}"]`)?.focus();
  }

  if (!model.selectedId && model.state.sessions[0]) model.selectedId = model.state.sessions[0].id;
  renderSession();
}

function renderAdapterDetails() {
  const adapter = model.state?.adapters.find((item) => item.id === $("#adapter-select").value);
  const availability = adapter?.availability;
  $("#adapter-note").textContent = availability?.note ?? "手机只能选择电脑端允许的项目。";
  const help = $("#adapter-help");
  help.hidden = !availability?.docsUrl;
  help.href = availability?.docsUrl ?? "#";
  $("#new-session-form button[type=submit]").disabled = availability?.supported === false || !availability?.available;
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
  if (!session) return;

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

function renderEvents() {
  const log = $("#event-log");
  const followsTail = !log.childElementCount || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const relevant = model.events.filter((event) => event.sessionId === model.selectedId);

  // Single pass: collect delta text per turn and completion state up front so
  // rendering stays O(n) even at the 1500-event cap on a phone.
  const deltaTextByTurn = new Map();
  const completedTurns = new Set();
  for (const event of relevant) {
    if (event.kind === "message.delta") {
      deltaTextByTurn.set(event.turnId, (deltaTextByTurn.get(event.turnId) ?? "") + String(event.payload.text ?? ""));
    } else if (event.kind === "message.completed" && event.payload.role === "assistant") {
      completedTurns.add(event.turnId);
    }
  }

  const renderedDeltas = new Set();
  const entries = [];
  for (const event of relevant) {
    if (event.kind === "message.delta") {
      if (completedTurns.has(event.turnId) || renderedDeltas.has(event.turnId)) continue;
      renderedDeltas.add(event.turnId);
      entries.push(entryHtml(event, "Agent 正在回复", deltaTextByTurn.get(event.turnId) ?? "", "assistant", true));
    } else if (event.kind === "message.completed") {
      entries.push(entryHtml(event, event.payload.role === "user" ? "你" : "Agent", event.payload.text, event.payload.role, true));
    } else if (event.kind === "tool.started" || event.kind === "tool.completed") {
      const label = event.kind.endsWith("started") ? "工具开始" : "工具完成";
      const detail = event.payload.command ? String(event.payload.command) : `${event.payload.type ?? "tool"}${event.payload.status ? ` · ${event.payload.status}` : ""}`;
      entries.push(entryHtml(event, label, detail, "tool"));
    } else if (event.kind === "approval.requested") {
      entries.push(approvalHtml(event));
    } else if (event.kind === "turn.failed" || event.kind === "session.failed" || event.kind === "adapter.exited") {
      entries.push(entryHtml(event, "执行异常", event.payload.error ?? event.payload.stderr ?? event.kind, "error"));
    } else if (["session.created", "session.ready", "turn.started", "turn.completed", "turn.cancelled", "control.granted", "turn.stop_requested", "model.changed"].includes(event.kind)) {
      entries.push(entryHtml(event, "状态", eventStatusLabel(event.kind), "tool"));
    }
  }
  log.innerHTML = entries.join("") || `<div class="empty-state"><div class="empty-rule"></div><h2>准备好了</h2><p>从下方发送第一条指令。真实 Agent 可能请求访问文件或运行命令。</p></div>`;
  if (followsTail) log.scrollTop = log.scrollHeight;
}

function entryHtml(event, label, text, className = "", supportsMarkdown = false) {
  const time = new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const content = supportsMarkdown
    ? renderMessageMarkdown(text)
    : `<p>${escapeHtml(String(text ?? ""))}</p>`;
  return `<article class="event-entry ${className}"><time class="event-time">${time}</time><div class="event-body"><strong>${escapeHtml(label)}</strong><div class="message-markdown">${content}</div></div></article>`;
}

function approvalHtml(event) {
  const request = JSON.stringify(event.payload.request ?? {}, null, 2).slice(0, 1600);
  return `<article class="event-entry"><time class="event-time">${new Date(event.time).toLocaleTimeString()}</time><div class="event-body approval-entry"><strong>需要你的批准</strong><p>${escapeHtml(event.payload.method)}\n${escapeHtml(request)}</p><div class="approval-actions"><button class="approve" data-approval="${event.payload.approvalId}" data-decision="approve" type="button">仅本次批准</button><button class="deny" data-approval="${event.payload.approvalId}" data-decision="deny" type="button">拒绝</button></div></div></article>`;
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
  const stream = new EventSource(`/api/events?after=${model.lastSeq}`);
  model.stream = stream;
  stream.addEventListener("open", () => setConnection("online", "实时同步"));
  stream.addEventListener("error", () => setConnection("offline", "正在重连"));
  stream.addEventListener("agent-event", (message) => {
    const event = JSON.parse(message.data);
    if (event.seq <= model.lastSeq) return;
    model.lastSeq = event.seq;
    model.events.push(event);
    // Announce only completed messages and recognized status changes; deltas
    // and tool chatter would spam the polite live region on every token.
    if (event.kind === "message.completed") {
      $("#event-announcer").textContent = `${event.payload.role === "user" ? "你" : "Agent"}：${String(event.payload.text ?? "").slice(0, 180)}`;
    } else if (event.kind === "approval.requested") {
      $("#event-announcer").textContent = "收到一条需要批准的请求";
    } else {
      const label = eventStatusLabel(event.kind);
      if (label !== event.kind) $("#event-announcer").textContent = label;
    }
    if (model.events.length > 1500) model.events.shift();
    const session = model.state.sessions.find((item) => item.id === event.sessionId);
    if (session) {
      if (event.kind === "turn.started") session.status = "running";
      if (event.kind === "turn.completed" || event.kind === "turn.cancelled") session.status = "ready";
      if (event.kind === "turn.failed") session.status = "failed";
      if (event.kind === "control.granted") session.controller = event.payload.controller;
      if (event.kind === "model.changed" && session.modelDirectory) session.modelDirectory.current = event.payload.selected;
    }
    if (event.kind.startsWith("session.")) void refreshState().catch((error) => toast(error.message));
    else { renderState(); }
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
$("#session-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-session-id]");
  if (!row) return;
  model.selectedId = row.dataset.sessionId;
  renderState();
  void rememberSession().catch((error) => toast(error.message));
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
  event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
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
