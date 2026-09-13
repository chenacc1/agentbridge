import test from "node:test";
import assert from "node:assert/strict";
import { createCommandId } from "../public/command-id.js";

test("command ids work when an embedded browser omits crypto.randomUUID", () => {
  const embeddedCrypto = {
    getRandomValues(bytes) {
      bytes.fill(7);
      return bytes;
    },
  };

  assert.doesNotThrow(() => createCommandId(embeddedCrypto));
  assert.match(createCommandId(embeddedCrypto), /^[0-9a-f-]{36}$/i);
});
