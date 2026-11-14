/**
 * Turn images that arrive with a desktop message into attachments the phone can show.
 *
 * Two shapes show up in practice, and they need different handling:
 *
 * 1. **Inline parts.** A message's `content` array carries `{ type: "image" }` with
 *    base64 bytes (that is how DSH admits a pasted screenshot). The phone cannot
 *    render those directly and the event log must not swallow tens of kilobytes of
 *    base64 per message, so the bytes go into the attachment store and the event
 *    carries a reference instead.
 *
 * 2. **A path in the text.** An agent that saved a screenshot says so — "已保存到
 *    D:\shots\port.png", or embeds `![说明](D:/shots/port.png)`. Nothing structured
 *    is attached to the event, so the path is the only signal there is. Only paths
 *    that exist on disk, look like images, and stay under the size cap are adopted;
 *    guessing wrong costs a row on the phone, so the rules stay narrow.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Extensions a phone can display in an <img>. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** A single image is capped so one screenshot cannot stall the phone's tail. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Upper bound on how many images one message may contribute. */
export const MAX_IMAGES_PER_MESSAGE = 4;

function mimeTypeOf(part) {
  const declared = String(part?.mediaType ?? part?.mimeType ?? part?.source?.mediaType ?? "").toLowerCase();
  if (declared.startsWith("image/")) return declared;
  // A data URL carries its own media type, and that is often the only place it is.
  const encoded = part?.data ?? part?.source?.data ?? part?.base64 ?? part?.source?.base64;
  if (typeof encoded === "string" && encoded.startsWith("data:")) {
    const fromUrl = /^data:([^;,]+)[;,]/.exec(encoded)?.[1]?.toLowerCase() ?? "";
    if (fromUrl.startsWith("image/")) return fromUrl;
  }
  const name = String(part?.name ?? part?.source?.name ?? part?.fileName ?? "");
  const extension = path.extname(name).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

function bytesOf(part) {
  const encoded = part?.data ?? part?.source?.data ?? part?.base64 ?? part?.source?.base64;
  if (typeof encoded !== "string" || !encoded.trim()) return null;
  // Tolerate a data URL, which some senders use where a bare base64 body is expected.
  const body = encoded.startsWith("data:") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
  try {
    const buffer = Buffer.from(body, "base64");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Inline image parts from a message's content array.
 *
 * Returns `{ images, content }`: the content with image parts removed (the phone gets
 * its own rows, and a message that was nothing but an image would otherwise render as
 * an empty bubble) plus the bytes ready to persist.
 */
export function splitInlineImages(content, { maxBytes = MAX_INLINE_IMAGE_BYTES, maxImages = MAX_IMAGES_PER_MESSAGE } = {}) {
  if (!Array.isArray(content)) return { images: [], content };
  const images = [];
  const kept = [];
  for (const part of content) {
    if (part?.type !== "image") {
      kept.push(part);
      continue;
    }
    if (images.length >= maxImages) continue;
    const mimeType = mimeTypeOf(part);
    const data = bytesOf(part);
    if (!mimeType || !data || data.length > maxBytes) continue;
    images.push({
      name: String(part?.name ?? part?.source?.name ?? `image-${images.length + 1}${path.extname(`x.${mimeType.split("/")[1]}`)}`),
      mimeType,
      data,
    });
  }
  return { images, content: kept };
}

/**
 * Store whatever images an event carries and describe them for the phone.
 *
 * Kept here (rather than inside the session manager) so the whole conversion is
 * testable with a real attachment store: the manager only calls it.
 *
 * A failure never loses the message: if the store refuses an image the text still
 * goes out, just without the picture.
 */
export async function persistEventImages({
  attachments,
  sessionId,
  kind,
  payload,
  base = process.cwd(),
  log = (message) => console.error(message),
} = {}) {
  if (!attachments || !payload || typeof payload !== "object") return payload;
  const inline = Array.isArray(payload.inlineImages) ? payload.inlineImages : [];
  const quoted = kind === "message.completed" || kind === "tool.completed"
    ? localImageFiles(payload.text, { base })
    : [];
  if (!inline.length && !quoted.length) return payload;

  const saved = [...(Array.isArray(payload.attachments) ? payload.attachments : [])];
  for (const image of [...inline, ...quoted].slice(0, MAX_IMAGES_PER_MESSAGE)) {
    try {
      const stored = await attachments.save({
        sessionId,
        name: image.name,
        mimeType: image.mimeType,
        data: image.data,
      });
      saved.push({ id: stored.id, name: stored.name, bytes: stored.bytes, mimeType: stored.mimeType, isImage: true });
    } catch (error) {
      log(`AgentBridge kept the message but not its image (${image.name}): ${error?.message ?? error}`);
    }
  }
  const { inlineImages, ...rest } = payload;
  void inlineImages;
  return { ...rest, attachments: saved };
}

/** Candidate paths in a piece of text: markdown images and bare absolute paths. */
export function imagePathCandidates(text) {
  const source = String(text ?? "");
  if (!source) return [];
  const found = [];
  const push = (value) => {
    const cleaned = String(value ?? "").trim().replace(/^["'(<]+|["')>]+$/g, "");
    if (cleaned && !found.includes(cleaned)) found.push(cleaned);
  };
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) push(match[1]);
  // A bare path, but not the tail of `./docs/a.png` — that one is already captured
  // above and would otherwise be adopted twice under a path that does not exist.
  for (const match of source.matchAll(/(?<![.\w])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|]+\.(?:png|jpe?g|webp|gif)\b/gi)) push(match[0]);
  return found.slice(0, 12);
}

/**
 * Image files mentioned in text that really exist on this machine.
 *
 * `base` resolves relative paths against the project the conversation belongs to,
 * which is what an agent's own working directory means to the reader.
 */
export function localImageFiles(text, {
  base = process.cwd(),
  exists = existsSync,
  stat = statSync,
  readFile = readFileSync,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  maxImages = MAX_IMAGES_PER_MESSAGE,
} = {}) {
  const files = [];
  const seen = new Set();
  for (const candidate of imagePathCandidates(text)) {
    if (files.length >= maxImages) break;
    const extension = path.extname(candidate).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
    // The same screenshot is often named twice: once as a path, once as a markdown
    // image. Adopting it twice would put two identical thumbnails on the phone.
    const identity = resolved.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      if (!exists(resolved) || !stat(resolved).isFile()) continue;
      const bytes = stat(resolved).size;
      if (bytes <= 0 || bytes > maxBytes) continue;
      files.push({ name: path.basename(resolved), mimeType: MIME_BY_EXTENSION[extension], data: readFile(resolved) });
    } catch {
      // A path that cannot be read is not worth reporting: the text still says it.
    }
  }
  return files;
}
