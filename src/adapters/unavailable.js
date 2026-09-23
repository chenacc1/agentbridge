import { probeCommand } from "./process-utils.js";

export class UnavailableAdapter {
  constructor({ id, label, command, note }) {
    this.id = id;
    this.label = label;
    this.command = command;
    this.note = note;
    this.capabilities = {
      create: false,
      attach: false,
      discover: false,
      streaming: false,
      approve: false,
      resume: false,
      cancel: false,
      selectModel: false,
      realAgent: true,
    };
  }

  async detect() {
    const result = await probeCommand(this.command);
    return { ...result, supported: false, note: this.note };
  }

  async start() {
    throw Object.assign(new Error(`${this.label} adapter is not implemented in this MVP`), { statusCode: 501 });
  }
}
