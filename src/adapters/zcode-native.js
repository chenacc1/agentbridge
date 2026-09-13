import { probeCommand } from "./process-utils.js";

const REMOTE_CONTROL_URL = "https://zcode.z.ai/en/docs/remote-control";

export class ZCodeNativeAdapter {
  id = "zcode";
  label = "ZCode（原生远控）";
  capabilities = {
    streaming: false,
    approvals: false,
    resume: false,
    cancel: false,
    realAgent: true,
    nativeRemoteControl: true,
  };
  #probe;

  constructor({ probe = probeCommand } = {}) {
    this.#probe = probe;
  }

  async detect() {
    const command = await this.#probe("zcode");
    return {
      ...command,
      supported: false,
      native: true,
      docsUrl: REMOTE_CONTROL_URL,
      note: "ZCode 的官方手机远控和微信 Bot 控制已打开的桌面工作区；它未公开可供 AgentBridge 创建或附着会话的本机 API。请在 ZCode 桌面端使用原生远控入口。",
    };
  }

  async start() {
    throw Object.assign(new Error("ZCode currently exposes native Remote Control/Bot Channel, not a third-party local session API"), { statusCode: 501 });
  }
}
