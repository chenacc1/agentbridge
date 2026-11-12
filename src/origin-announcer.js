/**
 * Tell an already-paired phone that the bridge moved.
 *
 * A Cloudflare quick tunnel hands out a new hostname every time the tunnel is
 * rebuilt, and the bridge is rebuilt often (desktop restart, tunnel restart). The
 * phone is sitting on the old origin: its page still renders, every request from
 * it fails, and nothing on the desktop says so. The QR code is not much help
 * either — the person is not looking at the desktop any more.
 *
 * So the address change is announced over the channel that still works when the
 * web page cannot: the push notification the user configured. One message per
 * change, only when a device actually exists to tell, and never on the first run
 * (nothing has "moved" yet).
 *
 * Everything that touches the machine is injectable because this decides whether a
 * third party gets a message, which is worth testing without a network.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function announcedOriginPath(dataDir) {
  return path.join(dataDir, "advertised-origin.json");
}

export function readAnnouncedOrigin(dataDir, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(String(readFile(announcedOriginPath(dataDir), "utf8")));
    return typeof parsed?.origin === "string" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function writeAnnouncedOrigin(dataDir, origin, { writeFile = writeFileSync, rename = renameSync, now = () => new Date().toISOString() } = {}) {
  const target = announcedOriginPath(dataDir);
  const temporary = `${target}.tmp`;
  writeFile(temporary, JSON.stringify({ origin, recordedAt: now() }, null, 2), "utf8");
  rename(temporary, target);
  return origin;
}

/** Whether this machine has ever recorded an address (i.e. it is not the first run). */
export function hasAnnouncedBefore(dataDir, options = {}) {
  return readAnnouncedOrigin(dataDir, options) !== null;
}

/**
 * Compare the address with the last one this bridge announced.
 *
 * Returns `{ announced, reason }`. A failure to notify is not thrown: the bridge is
 * already serving, and a dead webhook must not be able to stop that.
 */
export async function announceOriginChange({
  dataDir,
  origin,
  notifier = null,
  deviceCount = 0,
  machineName = "",
  log = () => {},
  read = readAnnouncedOrigin,
  write = writeAnnouncedOrigin,
} = {}) {
  if (!dataDir || !origin) return { announced: false, reason: "missing-argument" };

  const previous = read(dataDir);
  if (previous === origin) return { announced: false, reason: "unchanged" };

  // Record first: a crash mid-announcement must not turn one tunnel restart into a
  // notification loop on every subsequent launch.
  write(dataDir, origin);

  if (!previous) {
    log(`Recorded the first advertised address: ${origin}`);
    return { announced: false, reason: "first-run" };
  }
  if (deviceCount <= 0) return { announced: false, reason: "no-devices" };
  if (!notifier?.enabled) return { announced: false, reason: "notifications-disabled" };

  try {
    const result = await notifier.send(
      "bridge.moved",
      { previous, origin },
      { sessionTitle: machineName || "AgentBridge", adapterId: "agentbridge" },
    );
    if (result?.sent) log(`Announced the new address to ${deviceCount} paired device(s): ${origin}`);
    else log(`Address change not announced: ${result?.reason ?? "unknown"}`);
    return { announced: result?.sent === true, reason: result?.reason ?? null, previous };
  } catch (error) {
    log(`Address change announcement failed: ${error instanceof Error ? error.message : String(error)}`);
    return { announced: false, reason: "send-failed", previous };
  }
}
