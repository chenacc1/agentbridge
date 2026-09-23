export function adapterCreationPresentation(adapter) {
  const availability = adapter?.availability ?? {};
  const capabilities = adapter?.capabilities ?? {};
  const ready = availability.available === true && availability.supported !== false;
  const enabled = ready && capabilities.create === true;
  const native = availability.native === true;
  const attachOnly = ready && !enabled && capabilities.attach === true;

  return {
    enabled,
    selectable: enabled || native,
    suffix: enabled
      ? ""
      : native
        ? "（原生入口）"
        : attachOnly
          ? "（仅桌面附着）"
          : availability.available
            ? "（暂未接入）"
            : "（未安装）",
  };
}
