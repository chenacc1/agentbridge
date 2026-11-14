import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  imagePathCandidates,
  localImageFiles,
  persistEventImages,
  splitInlineImages,
} from "../src/inline-images.js";
import { AttachmentStore } from "../src/attachments.js";

// The request: a screenshot in the desktop's output should also be visible on the
// phone. The phone renders `payload.attachments`, so the job here is to turn whatever
// the desktop produced — inline bytes or a path in the text — into a stored reference.

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function base64(buffer) {
  return buffer.toString("base64");
}

test("an inline image part becomes an image to persist, and leaves the text alone", () => {
  const { images, content } = splitInlineImages([
    { type: "text", text: "看这张截图" },
    { type: "image", mediaType: "image/png", name: "shot.png", data: base64(PNG_BYTES) },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0].name, "shot.png");
  assert.equal(images[0].mimeType, "image/png");
  assert.deepEqual(images[0].data, PNG_BYTES);
  assert.deepEqual(content, [{ type: "text", text: "看这张截图" }], "the image part is not left to render as an empty block");
});

test("a data URL, a source-nested part and an unknown media type are all understood", () => {
  const dataUrl = splitInlineImages([{ type: "image", data: `data:image/jpeg;base64,${base64(PNG_BYTES)}` }]);
  assert.equal(dataUrl.images[0]?.mimeType, "image/jpeg");

  const nested = splitInlineImages([{ type: "image", source: { mediaType: "image/webp", data: base64(PNG_BYTES) } }]);
  assert.equal(nested.images[0]?.mimeType, "image/webp");

  const unknown = splitInlineImages([{ type: "image", mediaType: "text/plain", data: base64(PNG_BYTES) }]);
  assert.equal(unknown.images.length, 0, "only real images are adopted");
});

test("an oversized image is skipped instead of failing the message", () => {
  const { images } = splitInlineImages(
    [{ type: "image", mediaType: "image/png", data: base64(Buffer.alloc(2048)) }],
    { maxBytes: 1024 },
  );
  assert.equal(images.length, 0);
});

test("paths mentioned in a reply are found, relative ones resolved against the project", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-inline-"));
  try {
    await writeFile(path.join(dir, "port.png"), PNG_BYTES);
    const absolute = path.join(dir, "port.png");
    const text = `端口占用截图已保存到 ${absolute}\n\n![说明](./port.png)`;

    const candidates = imagePathCandidates(text);
    assert.ok(candidates.includes(absolute));
    assert.ok(candidates.includes("./port.png"));

    const files = localImageFiles(text, { base: dir });
    assert.equal(files.length, 1, "the same file mentioned twice is adopted once");
    assert.equal(files[0].name, "port.png");
    assert.equal(files[0].mimeType, "image/png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path that does not exist, or is not an image, is ignored", () => {
  const files = localImageFiles("看 D:\\build\\missing.png 和 D:\\build\\notes.txt", { base: "C:\\" });
  assert.deepEqual(files, []);
});

test("a stored image reaches the phone as an image row, and the base64 does not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-inline-store-"));
  const store = new AttachmentStore({ dataDir: dir });
  await store.init();
  try {
    const payload = {
      role: "assistant",
      text: "截图在下面",
      inlineImages: [{ name: "shot.png", mimeType: "image/png", data: PNG_BYTES }],
    };
    const next = await persistEventImages({ attachments: store, sessionId: "bs_test", kind: "message.completed", payload });

    assert.equal(next.inlineImages, undefined, "base64 must not survive into the event log");
    assert.equal(next.text, "截图在下面");
    assert.equal(next.attachments.length, 1);
    const row = next.attachments[0];
    assert.match(row.id, /^att_/);
    assert.equal(row.name, "shot.png");
    assert.equal(row.isImage, true);
    assert.equal(row.bytes, PNG_BYTES.length);

    // What the phone will actually load.
    const stored = await store.read(row.id);
    assert.equal(stored.mimeType, "image/png");
    assert.deepEqual(stored.data, PNG_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an image path in the reply text is attached too", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-inline-text-"));
  const store = new AttachmentStore({ dataDir: path.join(dir, "attachments") });
  await store.init();
  try {
    await writeFile(path.join(dir, "port.png"), PNG_BYTES);
    const next = await persistEventImages({
      attachments: store,
      sessionId: "bs_test",
      kind: "message.completed",
      payload: { role: "assistant", text: `已保存到 ${path.join(dir, "port.png")}` },
      base: dir,
    });
    assert.equal(next.attachments?.length, 1, "a file named in the text becomes a row");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing store costs the image, never the message", async () => {
  const next = await persistEventImages({
    attachments: { async save() { throw new Error("disk full"); } },
    sessionId: "bs_test",
    kind: "message.completed",
    payload: { role: "assistant", text: "重要结论", inlineImages: [{ name: "a.png", mimeType: "image/png", data: PNG_BYTES }] },
    log: () => {},
  });
  assert.equal(next.text, "重要结论");
  assert.deepEqual(next.attachments, []);
  assert.equal(next.inlineImages, undefined);
});
