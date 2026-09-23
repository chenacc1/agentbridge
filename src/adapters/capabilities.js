const methodCapabilities = {
  create: "start",
  attach: "attach",
  discover: "discoverConversations",
  cancel: "stop",
  approve: "resolveApproval",
  selectModel: "selectModel",
};

export function describeAdapterCapabilities(adapter) {
  const declared = adapter?.capabilities ?? {};
  const described = { ...declared };

  for (const [capability, method] of Object.entries(methodCapabilities)) {
    const legacy = capability === "cancel"
      ? declared.stop
      : capability === "approve"
        ? declared.approvals
        : undefined;
    described[capability] = Boolean(
      declared[capability]
      ?? legacy
      ?? (typeof adapter?.[method] === "function"),
    );
  }
  described.resume = Boolean(declared.resume);
  return described;
}

export function adapterSupports(adapter, capability) {
  return describeAdapterCapabilities(adapter)[capability] === true;
}
