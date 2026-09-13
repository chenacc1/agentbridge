import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export class PairingManager {
  #pairings = new Map();
  #sessions = new Map();
  #storePath;

  constructor({ pairingTtlMs, sessionTtlMs, now = () => Date.now(), storePath = null, accessKey = null }) {
    this.pairingTtlMs = pairingTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.accessKey = accessKey || null;
    this.#storePath = storePath;
    this.#load();
  }

  createPairing(origin, { targetSessionId = null } = {}) {
    const id = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.pairingTtlMs;
    let url = `${origin}/pair?code=${encodeURIComponent(id)}`;
    if (this.accessKey) url += `&key=${encodeURIComponent(this.accessKey)}`;
    const pairing = {
      id,
      expiresAt,
      state: "pending",
      targetSessionId,
      url,
    };
    this.#pairings.set(id, pairing);
    return { ...pairing };
  }

  getPendingPairing(id) {
    const pairing = this.#pairings.get(id);
    if (!pairing || pairing.state !== "pending" || pairing.expiresAt <= this.now()) {
      throw Object.assign(new Error("Pairing code is invalid, expired, or already used"), { statusCode: 410 });
    }
    return { ...pairing };
  }

  exchange(id, deviceName = "WeChat device") {
    const pairing = this.getPendingPairing(id);
    const storedPairing = this.#pairings.get(id);
    storedPairing.state = "used";

    return {
      ...this.createSession(deviceName, { lastSessionId: pairing.targetSessionId }),
      targetSessionId: pairing.targetSessionId,
    };
  }

  createSession(deviceName, { lastSessionId = null } = {}) {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = createdAt + this.sessionTtlMs;
    this.#sessions.set(id, { id, digest: digest(token), deviceName, createdAt, expiresAt, lastSessionId, revoked: false });
    this.#persist();
    return { id, token, deviceName, expiresAt, lastSessionId };
  }

  authenticate(token) {
    if (!token) return null;
    const candidate = digest(token);
    for (const session of this.#sessions.values()) {
      if (!session.revoked && session.expiresAt > this.now() && timingSafeEqual(candidate, session.digest)) {
        return {
          id: session.id,
          deviceName: session.deviceName,
          expiresAt: session.expiresAt,
          lastSessionId: session.lastSessionId ?? null,
        };
      }
    }
    return null;
  }

  revoke(id) {
    const session = this.#sessions.get(id);
    if (!session || session.revoked) return false;
    session.revoked = true;
    this.#persist();
    return true;
  }

  listDevices() {
    const now = this.now();
    return [...this.#sessions.values()]
      .filter((session) => !session.revoked && session.expiresAt > now)
      .map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        createdAt: session.createdAt ?? null,
        expiresAt: session.expiresAt,
        lastSessionId: session.lastSessionId ?? null,
      }));
  }

  setLastSession(id, lastSessionId) {
    const session = this.#sessions.get(id);
    if (!session || session.revoked || session.expiresAt <= this.now()) return false;
    session.lastSessionId = lastSessionId;
    this.#persist();
    return true;
  }

  // Only digests are stored, never raw tokens. Revoked and expired sessions are
  // dropped from the file entirely: absence from disk means "not authenticated".
  #persist() {
    if (!this.#storePath) return;
    const now = this.now();
    const sessions = [...this.#sessions.values()]
      .filter((session) => !session.revoked && session.expiresAt > now)
      .map((session) => ({
        id: session.id,
        digest: session.digest.toString("hex"),
        deviceName: session.deviceName,
        createdAt: session.createdAt ?? null,
        expiresAt: session.expiresAt,
        lastSessionId: session.lastSessionId ?? null,
      }));
    try {
      mkdirSync(path.dirname(this.#storePath), { recursive: true });
      const tempPath = `${this.#storePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify({ version: 1, sessions }), "utf8");
      renameSync(tempPath, this.#storePath);
    } catch (error) {
      console.error(`Failed to persist pairing sessions: ${error.message}`);
    }
  }

  #load() {
    if (!this.#storePath) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.#storePath, "utf8"));
    } catch {
      return;
    }
    if (!parsed || !Array.isArray(parsed.sessions)) return;
    const now = this.now();
    for (const record of parsed.sessions) {
      try {
        if (!record || record.revoked || !(record.expiresAt > now) || typeof record.id !== "string") continue;
        const digestBuffer = Buffer.from(String(record.digest), "hex");
        if (digestBuffer.length !== 32) continue;
        this.#sessions.set(record.id, {
          id: record.id,
          digest: digestBuffer,
          deviceName: String(record.deviceName ?? "Paired device"),
          createdAt: record.createdAt ?? null,
          expiresAt: record.expiresAt,
          lastSessionId: record.lastSessionId ?? null,
          revoked: false,
        });
      } catch {
        // Skip malformed records rather than refusing to start.
      }
    }
  }
}
