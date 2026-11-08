import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cloudflaredCandidates,
  ensureAccessKey,
  extractTunnelUrl,
  findCloudflared,
  readTunnelState,
  startQuickTunnel,
} from "../integrations/dsh-phone/lib/tunnel.js";

/** The banner cloudflared actually prints, wrapped across lines like it does. */
const REAL_BANNER = `2026-11-08T14:20:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a
2026-11-08T14:20:00Z INF cloudflared account, means the URL below changes on every restart.
2026-11-08T14:20:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-08T14:20:03Z INF +--------------------------------------------------------------------------------------------+
2026-11-08T14:20:03Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-08T14:20:03Z INF |  https://camcorders-responding-separate-give.trycloudflare.com                              |
2026-11-08T14:20:03Z INF +--------------------------------------------------------------------------------------------+
`;

test("the tunnel hostname is read out of the real cloudflared banner", () => {
  assert.equal(
    extractTunnelUrl(REAL_BANNER),
    "https://camcorders-responding-separate-give.trycloudflare.com",
  );
  assert.equal(extractTunnelUrl("no banner yet"), null);
  // An http URL is not what cloudflared announces, and a custom domain is not a
  // quick tunnel either: both must fall through rather than be guessed.
  assert.equal(extractTunnelUrl("http://example.com"), null);
  // The API endpoint quoted in cloudflared's own error messages looks almost
  // exactly like a tunnel hostname, and picking it up would hand the phone a URL
  // that never existed.
  assert.equal(extractTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded'), null);
});

test("cloudflared is found through the environment override first", () => {
  const env = {
    AGENTBRIDGE_CLOUDFLARED: "D:\\tools\\cloudflared.exe",
    PATH: "C:\\Windows;C:\\bin",
    ProgramFiles: "C:\\Program Files",
  };
  const seen = [];
  const found = findCloudflared({ env, home: "C:\\Users\\me", exists: (candidate) => { seen.push(candidate); return candidate === "C:\\Program Files\\cloudflared\\cloudflared.exe"; } });
  assert.equal(found, "C:\\Program Files\\cloudflared\\cloudflared.exe");
  assert.equal(seen[0], "D:\\tools\\cloudflared.exe");
  assert.ok(seen.includes(path.join("C:\\bin", "cloudflared.exe")));
  assert.equal(findCloudflared({ env, home: "C:\\Users\\me", exists: () => false }), null);
});

test("the access key is created once and reused afterwards", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-key-"));
  try {
    const first = ensureAccessKey(dir);
    assert.ok(first.length >= 16, "a generated key must satisfy the bridge minimum");
    assert.equal(ensureAccessKey(dir), first, "the phone's cookie depends on the key surviving a restart");

    // A truncated or hand-mangled file must not silently become the gate.
    await writeFile(path.join(dir, "access-key"), "short", "utf8");
    const replaced = ensureAccessKey(dir);
    assert.notEqual(replaced, "short");
    assert.equal(String(await readFile(path.join(dir, "access-key"), "utf8")).trim(), replaced);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A cloudflared stand-in: emits whatever the test tells it to, then idles. */
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    child.stdout.destroy = () => {};
    child.stderr.destroy = () => {};
    script({ child, calls });
    return child;
  };
  return { spawnImpl, calls };
}

test("a quick tunnel resolves with the hostname and records how to reuse it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-tunnel-"));
  try {
    const { spawnImpl, calls } = fakeSpawn(({ child }) => {
      setTimeout(() => child.stderr.emit("data", REAL_BANNER), 5);
    });
    const state = await startQuickTunnel({
      command: "cloudflared.exe",
      origin: "http://127.0.0.1:8787",
      dataDir: dir,
      spawnImpl,
      timeoutMs: 2_000,
    });
    assert.equal(state.url, "https://camcorders-responding-separate-give.trycloudflare.com");
    assert.equal(state.pid, 4242);
    assert.equal(state.reused, false);
    assert.deepEqual(calls[0].args.slice(0, 3), ["tunnel", "--no-autoupdate", "--url"]);
    assert.equal(calls[0].args[3], "http://127.0.0.1:8787");

    const onDisk = readTunnelState(dir);
    assert.equal(onDisk.url, state.url);
    assert.equal(onDisk.origin, "http://127.0.0.1:8787");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing tunnel is reused when its process is alive and it still answers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-tunnel-reuse-"));
  try {
    const { spawnImpl, calls } = fakeSpawn(({ child }) => {
      setTimeout(() => child.stderr.emit("data", REAL_BANNER), 5);
    });
    await startQuickTunnel({ command: "cloudflared.exe", origin: "http://127.0.0.1:8787", dataDir: dir, spawnImpl, timeoutMs: 2_000 });

    const reused = await startQuickTunnel({
      command: "cloudflared.exe",
      origin: "http://127.0.0.1:8787",
      dataDir: dir,
      spawnImpl,
      timeoutMs: 2_000,
      kill: () => true,
      fetchImpl: async () => ({ ok: false, status: 502 }),
    });
    assert.equal(reused.reused, true);
    assert.equal(calls.length, 1, "the second call must not spawn a second cloudflared");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tunnel that never announces a hostname fails loudly instead of hanging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-tunnel-timeout-"));
  let killed = null;
  try {
    const { spawnImpl } = fakeSpawn(({ child }) => {
      setTimeout(() => child.stderr.emit("data", "2026-11-08T14:20:00Z ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": context deadline exceeded\n"), 5);
    });
    await assert.rejects(
      startQuickTunnel({
        command: "cloudflared.exe",
        origin: "http://127.0.0.1:8787",
        dataDir: dir,
        spawnImpl,
        timeoutMs: 300,
        kill: (pid) => { killed = pid; },
      }),
      /did not announce a hostname within \d+s: .*context deadline exceeded/,
    );
    assert.equal(killed, 4242, "the stuck process is killed, not leaked");
    assert.equal(readTunnelState(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cloudflared that exits early reports the exit code", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-tunnel-exit-"));
  try {
    const { spawnImpl } = fakeSpawn(({ child }) => {
      setTimeout(() => child.emit("exit", 1), 5);
    });
    await assert.rejects(
      startQuickTunnel({ command: "cloudflared.exe", origin: "http://127.0.0.1:8787", dataDir: dir, spawnImpl, timeoutMs: 2_000 }),
      /exited with code 1/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the candidate list covers PATH, both Program Files, winget and the portable copy", () => {
  const candidates = cloudflaredCandidates({ PATH: "C:\\a", ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" }, "C:\\Users\\me");
  assert.ok(candidates.some((entry) => entry.startsWith("C:\\PF\\cloudflared")));
  assert.ok(candidates.some((entry) => entry.startsWith("C:\\PF86\\cloudflared")));
  assert.ok(candidates.some((entry) => entry.includes("WinGet")));
  assert.ok(candidates.some((entry) => entry.includes(path.join(".agentbridge", "bin"))));
});
