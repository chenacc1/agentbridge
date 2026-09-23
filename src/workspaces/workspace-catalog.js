import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

function pathKey(value, platform) {
  return platform === "win32" ? value.toLowerCase() : value;
}

function generatedAlias(canonicalPath) {
  const slug = path.basename(canonicalPath)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 22) || "project";
  const suffix = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 8);
  return `local-${slug}-${suffix}`.slice(0, 40);
}

function validateAlias(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
}

function copy(record) {
  return record ? { ...record } : null;
}

export class WorkspaceCatalog {
  #byId = new Map();
  #byAlias = new Map();
  #byPath = new Map();
  #writes = Promise.resolve();
  #revision = 0;

  constructor({ filePath, initialProjects = new Map(), platform = process.platform, now = () => new Date().toISOString() }) {
    this.filePath = filePath;
    this.initialProjects = initialProjects;
    this.platform = platform;
    this.now = now;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.#load();
    let changed = false;
    for (const [alias, requestedPath] of this.initialProjects) {
      const result = await this.#registerRecord({ requestedPath, alias, source: "config" });
      changed ||= result.changed;
    }
    if (changed) await this.#persist();
    return this;
  }

  get revision() {
    return this.#revision;
  }

  list() {
    return [...this.#byId.values()]
      .map(copy)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listPublic() {
    return this.list()
      .filter((record) => record.enabled)
      .map(({ id, alias, name, enabled }) => ({ id, alias, name, enabled }));
  }

  get(identifier) {
    return copy(this.#byId.get(identifier) ?? this.#byAlias.get(identifier));
  }

  async register({ requestedPath, alias = null, source = "local" }) {
    const result = await this.#registerRecord({ requestedPath, alias, source });
    if (result.changed) await this.#persist();
    return copy(result.record);
  }

  async disable(identifier) {
    const record = this.#byId.get(identifier) ?? this.#byAlias.get(identifier);
    if (!record || !record.enabled) return false;
    record.enabled = false;
    record.updatedAt = this.now();
    this.#revision += 1;
    await this.#persist();
    return true;
  }

  async #canonicalize(requestedPath) {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) {
      throw Object.assign(new Error("cwd must be an absolute local path"), { statusCode: 400 });
    }
    let canonicalPath;
    try {
      canonicalPath = await realpath(requestedPath);
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw Object.assign(new Error("cwd must be an existing directory"), { statusCode: 400 });
    }
    return canonicalPath;
  }

  async #registerRecord({ requestedPath, alias, source }) {
    const canonicalPath = await this.#canonicalize(requestedPath);
    const existing = this.#byPath.get(pathKey(canonicalPath, this.platform));
    if (existing) {
      if (!existing.enabled) {
        existing.enabled = true;
        existing.updatedAt = this.now();
        this.#revision += 1;
        return { record: existing, changed: true };
      }
      return { record: existing, changed: false };
    }

    const selectedAlias = alias ?? generatedAlias(canonicalPath);
    if (!validateAlias(selectedAlias)) {
      throw Object.assign(new Error("Workspace alias is invalid"), { statusCode: 400 });
    }
    if (this.#byAlias.has(selectedAlias)) {
      throw Object.assign(new Error(`Workspace alias already belongs to another path: ${selectedAlias}`), { statusCode: 409 });
    }

    const timestamp = this.now();
    const record = {
      id: `ws_${randomUUID()}`,
      alias: selectedAlias,
      name: path.basename(canonicalPath) || selectedAlias,
      canonicalPath,
      source: source === "config" ? "config" : "local",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#index(record);
    this.#revision += 1;
    return { record, changed: true };
  }

  #index(record) {
    this.#byId.set(record.id, record);
    this.#byAlias.set(record.alias, record);
    this.#byPath.set(pathKey(record.canonicalPath, this.platform), record);
  }

  async #load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw Object.assign(new Error(`Workspace catalog could not be read: ${error.message}`), { cause: error });
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
      throw new Error("Workspace catalog has an unsupported schema");
    }
    this.#revision = Number.isSafeInteger(parsed.revision) ? parsed.revision : 0;
    for (const record of parsed.items) {
      if (!record || typeof record.id !== "string" || !validateAlias(record.alias) || !path.isAbsolute(record.canonicalPath)) {
        throw new Error("Workspace catalog contains an invalid record");
      }
      this.#index({
        id: record.id,
        alias: record.alias,
        name: String(record.name || path.basename(record.canonicalPath) || record.alias).slice(0, 100),
        canonicalPath: record.canonicalPath,
        source: record.source === "config" ? "config" : "local",
        enabled: record.enabled !== false,
        createdAt: String(record.createdAt || this.now()),
        updatedAt: String(record.updatedAt || record.createdAt || this.now()),
      });
    }
  }

  #persist() {
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      revision: this.#revision,
      items: this.list(),
    });
    const operation = this.#writes.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      const handle = await open(temporaryPath, "w");
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
    });
    this.#writes = operation;
    return operation;
  }
}
