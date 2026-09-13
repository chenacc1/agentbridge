import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KIMI_PROVIDER_ID = "cc-switch:kimi";
const KIMI_MODELS = [
  { id: "kimi-for-coding", name: "Kimi K2.7 Code", note: "256K 上下文" },
  { id: "k3-256k", name: "Kimi K3 256K", note: "K3，256K 上下文" },
  { id: "k3", name: "Kimi K3", note: "K3；可用上下文取决于会员权益" },
];

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function isKimiCodingEndpoint(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding");
  } catch {
    return false;
  }
}

function isLocalProxyEndpoint(value) {
  try {
    const url = new URL(String(value ?? ""));
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export class CcSwitchModelCatalog {
  constructor({ homeDir = os.homedir(), readFile: read = readFile, openDatabase = (filePath) => new DatabaseSync(filePath, { readOnly: true }) } = {}) {
    this.homeDir = homeDir;
    this.readFile = read;
    this.openDatabase = openDatabase;
  }

  async current() {
    const ccSwitchPath = path.join(this.homeDir, ".cc-switch", "settings.json");
    const claudePath = path.join(this.homeDir, ".claude", "settings.json");
    let ccSwitch;
    let claude;
    try {
      [ccSwitch, claude] = await Promise.all([
        this.readFile(ccSwitchPath, "utf8").then(parseJson),
        this.readFile(claudePath, "utf8").then(parseJson),
      ]);
    } catch {
      return null;
    }
    const providerId = String(ccSwitch?.currentProviderClaude ?? "");
    const activeEndpoint = String(claude?.env?.ANTHROPIC_BASE_URL ?? "");
    const selectedEndpoint = this.#providerEndpoint(providerId);
    const usesCcSwitchProxy = ccSwitch?.enableLocalProxy === true && isLocalProxyEndpoint(activeEndpoint);
    if (!providerId || !isKimiCodingEndpoint(selectedEndpoint) || (!isKimiCodingEndpoint(activeEndpoint) && !usesCcSwitchProxy)) return null;

    const configuredModel = String(claude?.env?.ANTHROPIC_MODEL ?? "");
    const knownModel = KIMI_MODELS.some((entry) => entry.id === configuredModel);
    return {
      source: "cc-switch",
      label: "CC Switch · Kimi 模型",
      description: "仅影响此手机会话后续的 Claude 回合；不会修改 CC Switch 厂商、密钥或代理。",
      routable: true,
      current: knownModel ? { provider: KIMI_PROVIDER_ID, model: configuredModel } : null,
      groups: [{ id: KIMI_PROVIDER_ID, name: "Kimi（CC Switch 当前厂商）", models: KIMI_MODELS }],
      failures: [],
    };
  }

  #providerEndpoint(providerId) {
    let database;
    try {
      database = this.openDatabase(path.join(this.homeDir, ".cc-switch", "cc-switch.db"));
      const row = database.prepare("SELECT url FROM provider_endpoints WHERE provider_id = ? AND app_type = 'claude' LIMIT 1").get(providerId);
      return row?.url ?? null;
    } catch {
      return null;
    } finally {
      database?.close();
    }
  }
}
