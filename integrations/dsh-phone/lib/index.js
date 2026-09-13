import { randomUUID } from "node:crypto";

const name = "agentbridge-dsh-phone";
const inject = ["commands", "apiProxy", "llm"];
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";
const POLL_DELAY_MS = 800;
const EVENT_BATCH_DELAY_MS = 120;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function textFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function selectionFromAgent(agent) {
  let logged;
  try {
    logged = agent.session.requestHeader?.()?.config;
  } catch {
    logged = undefined;
  }
  const provider = agent.options?.provider || logged?.provider;
  const model = agent.options?.model || logged?.model;
  if (!provider || !model) return null;
  const reasoningEffort = agent.options?.reasoningEffort || logged?.reasoningEffort;
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function compactModelDirectory(value, current, extraFailures = []) {
  const groups = Array.isArray(value?.groups) ? value.groups.slice(0, 30).map((group) => ({
    id: group.id,
    name: group.name,
    models: Array.isArray(group.models) ? group.models.slice(0, 200).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.reasoning ? { reasoning: {
        efforts: Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts.slice(0, 20) : [],
        ...(model.reasoning.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}),
      } } : {}),
    })) : [],
  })) : [];
  const failures = [...extraFailures, ...(Array.isArray(value?.failures) ? value.failures : [])].slice(0, 30);
  return {
    current,
    routable: current ? groups.some((group) => group.id === current.provider) : false,
    groups,
    failures,
  };
}

async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `AgentBridge request failed (${response.status})`);
  return body;
}

class PhoneConnections {
  constructor(ctx) {
    this.ctx = ctx;
    this.bySession = new Map();
    this.liveModelSelections = new WeakMap();
    this.ctx.on("session/event", (session, event) => this.captureEvent(session, event));
    this.ctx.on("agent/disposed", ({ agent }) => this.close(agent.session.id));
  }

  async connect(agent) {
    this.close(agent.session.id);
    const origin = String(process.env.AGENTBRIDGE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
    const modelDirectory = await this.modelDirectory(agent);
    const response = await fetch(`${origin}/api/local/dsh-desktop/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agent.session.id,
        cwd: agent.session.header.cwd,
        title: agent.session.header.title,
        provider: agent.options.provider,
        model: agent.options.model,
        modelDirectory,
      }),
    });
    const registration = await readResponse(response);
    const state = {
      agent,
      origin,
      channel: registration.channel,
      controller: new AbortController(),
      cursor: 0,
      pendingEvents: [],
      phoneMessageIds: new Set(),
      eventTimer: null,
    };
    this.bySession.set(agent.session.id, state);
    void this.poll(state);
    return registration;
  }

  async modelDirectory(agent) {
    const current = selectionFromAgent(agent);
    try {
      const response = await this.ctx.apiProxy.sessions.models({
        rpcId: randomUUID(),
        payload: { sessionId: agent.session.id },
      });
      const result = response?.result;
      if (!result?.ok) {
        if (result?.error?.code === "session-not-found") {
          return await this.hostModelDirectory(current, result.error.message);
        }
        throw new Error(result?.error?.message || "DSH Desktop did not provide its model directory");
      }
      return result.value;
    } catch (error) {
      return {
        current,
        routable: false,
        groups: [],
        failures: [{ id: "dsh-model-directory", name: "DSH Desktop", message: textFromError(error) }],
      };
    }
  }

  async hostModelDirectory(current, sessionError) {
    const response = await this.ctx.apiProxy.llm.models({ rpcId: randomUUID(), payload: {} });
    const result = response?.result;
    if (!result?.ok) throw new Error(result?.error?.message || "DSH Desktop did not provide its host model directory");
    return compactModelDirectory(result.value, current, [{
      id: "dsh-session-models",
      name: "DSH Desktop",
      message: `当前 UI 会话不在 session.models 注册表中，已改用 DSH 全局模型目录：${sessionError}`,
    }]);
  }

  liveModelSelection(agent) {
    const existing = this.liveModelSelections.get(agent);
    if (existing) return existing;
    const selection = { current: selectionFromAgent(agent), assembled: undefined };
    agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const selected = selection.current;
      const assembled = await next();
      selection.assembled = selected;
      if (!selected) return assembled;
      return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
    });
    agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      const selected = selection.assembled;
      if (!selected) return resolved;
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      };
    });
    this.liveModelSelections.set(agent, selection);
    return selection;
  }

  async selectModel(agent, requested) {
    const response = await this.ctx.apiProxy.sessions.selectModel({
      rpcId: randomUUID(),
      payload: { sessionId: agent.session.id, ...requested },
    });
    const result = response?.result;
    if (result?.ok) return result.value.selected;
    if (result?.error?.code !== "session-not-found") {
      throw new Error(result?.error?.message || "DSH Desktop rejected the model selection");
    }
    const resolved = await this.ctx.llm.resolveCallConfig(requested);
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
    };
    this.liveModelSelection(agent).current = selected;
    return selected;
  }

  async reportCommandResult(state, requestId, result) {
    const response = await fetch(`${state.origin}${state.channel.resultsPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.channel.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId, result }),
      signal: state.controller.signal,
    });
    await readResponse(response);
  }

  close(sessionId) {
    const state = this.bySession.get(sessionId);
    if (!state) return;
    state.controller.abort();
    if (state.eventTimer) clearTimeout(state.eventTimer);
    this.bySession.delete(sessionId);
  }

  captureEvent(session, event) {
    const state = this.bySession.get(session.id);
    if (!state || state.controller.signal.aborted) return;
    const origin = event.type === "user/message" && state.phoneMessageIds.delete(event.data?.id)
      ? "phone"
      : "desktop";
    state.pendingEvents.push({ event, origin });
    if (state.pendingEvents.length >= 50) return void this.flushEvents(state);
    if (!state.eventTimer) {
      state.eventTimer = setTimeout(() => {
        state.eventTimer = null;
        void this.flushEvents(state);
      }, EVENT_BATCH_DELAY_MS);
    }
  }

  async flushEvents(state) {
    if (state.controller.signal.aborted || state.pendingEvents.length === 0) return;
    const events = state.pendingEvents.splice(0, 200);
    try {
      const response = await fetch(`${state.origin}${state.channel.eventsPath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.channel.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events }),
        signal: state.controller.signal,
      });
      await readResponse(response);
    } catch (error) {
      if (!state.controller.signal.aborted) {
        state.pendingEvents.unshift(...events);
        this.ctx.logger.warn(`AgentBridge event sync failed: ${textFromError(error)}`);
        await sleep(1_000, state.controller.signal);
        if (!state.controller.signal.aborted) void this.flushEvents(state);
      }
    }
  }

  async poll(state) {
    while (!state.controller.signal.aborted) {
      try {
        const response = await fetch(`${state.origin}${state.channel.pollPath}?after=${state.cursor}`, {
          headers: { authorization: `Bearer ${state.channel.token}` },
          signal: state.controller.signal,
        });
        const body = await readResponse(response);
        for (const command of body.commands || []) {
          if (command.kind === "message") {
            const message = createUserMessage(command.text);
            state.phoneMessageIds.add(message.id);
            state.agent.followup(message);
          } else if (command.kind === "cancel") {
            state.agent.cancel({ kind: "user" }, { keepInbox: true });
          } else if (command.kind === "select-model") {
            try {
              const selected = await this.selectModel(state.agent, {
                provider: command.selection?.provider,
                model: command.selection?.model,
                ...(command.selection?.reasoningEffort ? { reasoningEffort: command.selection.reasoningEffort } : {}),
              });
              await this.reportCommandResult(state, command.requestId, { ok: true, selected });
            } catch (error) {
              await this.reportCommandResult(state, command.requestId, { ok: false, error: textFromError(error) });
            }
          }
          state.cursor = Math.max(state.cursor, command.seq);
        }
      } catch (error) {
        if (!state.controller.signal.aborted) {
          this.ctx.logger.warn(`AgentBridge command polling failed: ${textFromError(error)}`);
        }
      }
      await sleep(POLL_DELAY_MS, state.controller.signal);
    }
  }
}

function apply(ctx) {
  const connections = new PhoneConnections(ctx);
  ctx.commands.register({
    name: "phone",
    description: "pair this exact DSH Desktop conversation with a phone",
    recordInput: false,
    handler: async ({ agent }) => {
      if (!agent.session.header.cwd) {
        return { kind: "error", text: "当前会话没有项目目录，无法绑定手机。请先在项目文件夹中打开会话。" };
      }
      try {
        const registration = await connections.connect(agent);
        const model = [agent.options.provider, agent.options.model].filter(Boolean).join(" / ") || "当前 DSH 配置";
        return {
          kind: "success",
          text: [
            "手机接管二维码已生成（5 分钟内、仅可使用一次）：",
            `![AgentBridge 手机二维码](${registration.qrImageUrl})`,
            registration.pairing.url,
            `项目：${registration.project.cwd}`,
            `会话：${agent.session.id}`,
            `模型：${model}`,
          ].join("\n\n"),
        };
      } catch (error) {
        return {
          kind: "error",
          text: `无法连接 AgentBridge：${textFromError(error)}。请确认本机 http://127.0.0.1:8787 正在运行。`,
        };
      }
    },
  });
}

export { apply, inject, name };
