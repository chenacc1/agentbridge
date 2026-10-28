import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

/**
 * Attachments for phone-sent messages.
 *
 * A phone is the device most likely to hold the thing the agent needs — a
 * screenshot of the error, a photo of the whiteboard, a log file — and before this
 * there was no way to get one across. Files are written under the bridge data
 * directory, described in a small catalog so a preview URL survives a restart, and
 * bounded hard: a phone on a tunnel must not be able to fill the disk.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_FILES_PER_SESSION = 60;

const EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/zip": ".zip",
};

export function extensionFor(mimeType, name = "") {
  const byMime = EXTENSIONS[String(mimeType ?? "").toLowerCase()];
  if (byMime) return byMime;
  const byName = path.extname(String(name)).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(byName) ? byName : ".bin";
}

export function isImage(mimeType) {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(String(mimeType ?? ""));
}

function cleanName(value) {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_");
  return name.slice(-120) || "attachment";
}

export class AttachmentStore {
  #byId = new Map();
  #catalogPath;
  #directory;
  #writes = Promise.resolve();
  #now;

  constructor({ dataDir, now = () => Date.now() }) {
    this.#directory = path.join(dataDir, "attachments");
    this.#catalogPath = path.join(this.#directory, "attachments.json");
    this.#now = now;
  }

  get maxBytes() {
    return MAX_BYTES;
  }

  async init() {
    await mkdir(this.#directory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#catalogPath, "utf8"));
      for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
        if (typeof entry?.id === "string" && typeof entry?.file === "string") this.#byId.set(entry.id, entry);
      }
    } catch {
      // No catalog yet: a fresh data directory is not an error.
    }
  }

  list(sessionId) {
    return [...this.#byId.values()]
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  get(id) {
    return this.#byId.get(id) ?? null;
  }

  /** Absolute path for an attachment, or null when it is unknown. */
  pathOf(id) {
    const entry = this.#byId.get(id);
    return entry ? path.join(this.#directory, entry.file) : null;
  }

  /**
   * Store one upload. `data` is a Buffer; anything larger than `maxBytes` is
   * rejected before it is written, and the catalog is trimmed oldest-first so a
   * phone cannot grow the directory without bound.
   */
  async save({ sessionId, name, mimeType, data }) {
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw Object.assign(new Error("The upload is empty"), { statusCode: 400 });
    }
    if (data.length > MAX_BYTES) {
      throw Object.assign(new Error(`附件不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`), { statusCode: 413 });
    }
    const sessionFiles = this.list(sessionId);
    if (sessionFiles.length >= MAX_FILES_PER_SESSION) {
      const oldest = sessionFiles.at(-1);
      await this.#remove(oldest.id);
    }
    const id = `att_${randomUUID()}`;
    const fileName = `${createHash("sha256").update(id).digest("hex").slice(0, 24)}${extensionFor(mimeType, name)}`;
    const target = path.join(this.#directory, fileName);
    const handle = await open(target, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const entry = {
      id,
      sessionId,
      name: cleanName(name),
      mimeType: String(mimeType ?? "application/octet-stream").toLowerCase().slice(0, 120),
      bytes: data.length,
      file: fileName,
      createdAt: this.#now(),
    };
    this.#byId.set(id, entry);
    await this.#persist();
    return { ...entry };
  }

  async remove(id) {
    return this.#remove(id);
  }

  async #remove(id) {
    const entry = this.#byId.get(id);
    if (!entry) return false;
    this.#byId.delete(id);
    await rm(path.join(this.#directory, entry.file), { force: true });
    await this.#persist();
    return true;
  }

  /** Read the bytes back for a provider that needs them inline (base64). */
  async read(id) {
    const entry = this.#byId.get(id);
    if (!entry) return null;
    const buffer = await readFile(path.join(this.#directory, entry.file));
    return { ...entry, data: buffer };
  }

  async sizeOf(id) {
    const entry = this.#byId.get(id);
    if (!entry) return null;
    try {
      const info = await stat(path.join(this.#directory, entry.file));
      return info.size;
    } catch {
      return null;
    }
  }

  #persist() {
    const payload = JSON.stringify({
      version: 1,
      items: [...this.#byId.values()]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_ENTRIES),
    });
    // Once over the cap, the entries that fell out are removed from disk too.
    for (const entry of this.#byId.values()) {
      if (!payload.includes(entry.id)) {
        this.#byId.delete(entry.id);
        void rm(path.join(this.#directory, entry.file), { force: true });
      }
    }
    const operation = this.#writes.catch(() => undefined).then(async () => {
      const temporary = `${this.#catalogPath}.tmp`;
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, this.#catalogPath);
    });
    this.#writes = operation;
    return operation;
  }
}
