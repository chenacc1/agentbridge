export function adapterCreationPresentation(adapter) {
  const availability = adapter?.availability ?? {};
  const capabilities = adapter?.capabilities ?? {};
  const ready = availability.available === true && availability.supported !== false;
  const enabled = ready && capabilities.create === true;
  const native = availability.native === true;
  const attachOnly = ready && !enabled && capabilities.attach === true;
  // Why an Agent cannot open a conversation right now. The Agent names the reason
  // itself ("桌面端离线"), which is far more useful than a generic "仅桌面附着":
  // the same Agent does become creatable as soon as its companion connects.
  const blocked = typeof capabilities.createReason === "string" ? capabilities.createReason.trim() : "";

  return {
    enabled,
    selectable: enabled || native,
    blocked,
    suffix: enabled
      ? ""
      : native
        ? "（原生入口）"
        : blocked
          ? `（${blocked}）`
          : attachOnly
            ? "（仅桌面附着）"
            : availability.available
              ? "（暂未接入）"
              : "（未安装）",
  };
}
