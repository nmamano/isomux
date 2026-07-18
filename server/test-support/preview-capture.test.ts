// preview-capture unit tests (task dcfd5a97) — the capturePreview seam with
// injected deps. The "browser" is a fake shell script (via deps.findBrowser),
// so the REAL spawn / group-kill / temp-dir-cleanup paths run deterministically
// without Chrome; a fetchFn fake keeps the suite network-free. Zero LLM.
//
// What this freezes:
//   - strict validation (no clamping): url/viewport/wait violations are 400
//     invalid_request BEFORE any network or process work. Syntax-only: any
//     http(s) host — loopback, private, or public — is accepted (the
//     local/private-only input policy was dropped in task fb02f521).
//   - engine/no_browser, pre-flight/unreachable, child nonzero + stderr tail,
//     no/invalid PNG, timeout kill, and busy (429, no queueing) all map to
//     the distinct codes the design pinned — and the temp dir is gone and the
//     concurrency slot released on every path.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  capturePreview,
  type PreviewCaptureDeps,
  type PreviewResult,
} from "../preview-capture.ts";

let scriptDir: string;
let tmpBase: string;
let fakeBrowser: string; // writes a valid PNG to the --screenshot path
let slowBrowser: string; // sleeps forever (until killed)
let hangingBrowser: string; // writes a valid PNG, then hangs instead of exiting
let lateWriterBrowser: string; // writes a valid PNG only after 1s
let stubbornBrowser: string; // ignores SIGTERM and sleeps forever
let failingBrowser: string; // exits 3 with stderr, writes nothing
let silentBrowser: string; // exits 0 without writing a screenshot
let junkBrowser: string; // writes a non-PNG file

function script(name: string, body: string): string {
  const p = join(scriptDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Shared arg-parsing preamble: extracts the --screenshot=<path> value.
const FIND_OUT = `out=""
for a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; esac; done`;
// A minimal COMPLETE png as far as isCompletePng is concerned: the 8-byte
// signature (89 50 4E 47 0D 0A 1A 0A), some body, and a trailing IEND chunk
// (len + "IEND" + CRC). Octal escapes for the non-ASCII bytes.
const WRITE_PNG = `printf '\\211PNG\\r\\n\\032\\n' > "$out"
printf 'IHDRfakepixels' >> "$out"
printf '\\0\\0\\0\\0IEND\\256B\\140\\202' >> "$out"`;

beforeAll(() => {
  scriptDir = mkdtempSync(join(tmpdir(), "preview-test-scripts-"));
  tmpBase = mkdtempSync(join(tmpdir(), "preview-test-tmpbase-"));
  fakeBrowser = script("fake-browser.sh", `${FIND_OUT}\n${WRITE_PNG}`);
  slowBrowser = script("slow-browser.sh", "sleep 600");
  hangingBrowser = script(
    "hanging-browser.sh",
    `${FIND_OUT}\n${WRITE_PNG}\nsleep 600`,
  );
  lateWriterBrowser = script(
    "late-writer-browser.sh",
    `${FIND_OUT}\nsleep 1\n${WRITE_PNG}\nsleep 600`,
  );
  stubbornBrowser = script("stubborn-browser.sh", `trap '' TERM\nsleep 600`);
  failingBrowser = script(
    "failing-browser.sh",
    'echo "chrome exploded: boom" >&2\nexit 3',
  );
  silentBrowser = script("silent-browser.sh", "exit 0");
  junkBrowser = script("junk-browser.sh", `${FIND_OUT}\necho notapng > "$out"`);
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
  rmSync(tmpBase, { recursive: true, force: true });
});

const okFetch: typeof fetch = (() =>
  Promise.resolve(new Response("ok"))) as unknown as typeof fetch;

function deps(overrides: Partial<PreviewCaptureDeps> = {}): PreviewCaptureDeps {
  return {
    findBrowser: () => fakeBrowser,
    fetchFn: okFetch,
    tmpBase,
    ...overrides,
  };
}

function expectFail(
  r: PreviewResult,
  status: number,
  code: string,
): asserts r is Extract<PreviewResult, { ok: false }> {
  if (r.ok) throw new Error(`expected ${code}, got ok`);
  expect(r.status).toBe(status as never);
  expect(r.code).toBe(code as never);
}

function tmpLeftovers(): string[] {
  return readdirSync(tmpBase).filter((d) => d.startsWith("isomux-preview-"));
}

describe("preview-capture: validation (strict, no clamping)", () => {
  const cases: Array<[string, unknown]> = [
    ["missing url", {}],
    ["non-string url", { url: 42 }],
    ["unparseable url", { url: "not a url" }],
    ["non-http scheme", { url: "ftp://localhost/x" }],
    ["file scheme", { url: "file:///etc/passwd" }],
    ["embedded credentials", { url: "http://user:pw@localhost:3000/" }],
    ["url too long", { url: `http://localhost/${"a".repeat(2050)}` }],
    [
      "viewport not an object",
      { url: "http://127.0.0.1:3000/", viewport: "big" },
    ],
    [
      "viewport non-integer",
      {
        url: "http://127.0.0.1:3000/",
        viewport: { width: 800.5, height: 600 },
      },
    ],
    [
      "viewport under min",
      { url: "http://127.0.0.1:3000/", viewport: { width: 100, height: 600 } },
    ],
    [
      "viewport over max",
      { url: "http://127.0.0.1:3000/", viewport: { width: 800, height: 9000 } },
    ],
    ["wait negative", { url: "http://127.0.0.1:3000/", wait: -1 }],
    ["wait over max", { url: "http://127.0.0.1:3000/", wait: 10001 }],
    ["wait non-integer", { url: "http://127.0.0.1:3000/", wait: 3.5 }],
  ];
  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 invalid_request`, async () => {
      expectFail(await capturePreview(body, deps()), 400, "invalid_request");
    });
  }
});

describe("preview-capture: any host passes validation (policy dropped, fb02f521)", () => {
  // Syntax-only validation now: loopback, private, AND public hosts are all
  // accepted. findBrowser:null stops the run cheaply right after validation —
  // reaching no_browser PROVES the URL was accepted.
  const hosts = [
    "127.0.0.1",
    "192.168.1.1",
    "100.100.7.7", // tailscale CGNAT
    "[::1]",
    "8.8.8.8", // public IPv4 — rejected under the old policy
    "[2001:4860:4860::8888]", // public IPv6
    "example.com", // named host, no DNS resolution step anymore
    "auntie", // single-label host
  ];
  for (const host of hosts) {
    it(`accepts http://${host}`, async () => {
      const r = await capturePreview(
        { url: `http://${host}:3000/` },
        deps({ findBrowser: () => null }),
      );
      expectFail(r, 500, "no_browser");
    });
  }

  it("accepts an https URL to a public named host", async () => {
    const r = await capturePreview(
      { url: "https://example.com/some/page" },
      deps({ findBrowser: () => null }),
    );
    expectFail(r, 500, "no_browser");
  });
});

describe("preview-capture: engine, pre-flight, and capture failures", () => {
  it("no browser found -> 500 no_browser", async () => {
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => null }),
    );
    expectFail(r, 500, "no_browser");
  });

  it("pre-flight network failure -> 500 unreachable, no temp dir left", async () => {
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({
        fetchFn: (() =>
          Promise.reject(
            new Error("connect ECONNREFUSED"),
          )) as unknown as typeof fetch,
      }),
    );
    expectFail(r, 500, "unreachable");
    expect(r.error).toContain("ECONNREFUSED");
    expect(tmpLeftovers()).toEqual([]);
  });

  it("child nonzero exit -> 500 capture_failed with stderr tail; temp dir removed", async () => {
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => failingBrowser }),
    );
    expectFail(r, 500, "capture_failed");
    expect(r.error).toContain("code 3");
    expect(r.error).toContain("chrome exploded: boom");
    expect(tmpLeftovers()).toEqual([]);
  });

  it("child exits clean without writing a screenshot -> capture_failed", async () => {
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => silentBrowser }),
    );
    expectFail(r, 500, "capture_failed");
    expect(r.error).toContain("no screenshot");
  });

  it("child writes a non-PNG -> capture_failed (signature check)", async () => {
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => junkBrowser }),
    );
    expectFail(r, 500, "capture_failed");
    expect(r.error).toContain("invalid");
  });

  it("deadline exceeded -> capture_timeout, child killed, temp dir removed", async () => {
    const started = Date.now();
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => slowBrowser, deadlineMs: 400 }),
    );
    expectFail(r, 500, "capture_timeout");
    // SIGTERM at the 400ms deadline; sh dies on it, so no grace needed.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("PNG completed only AFTER the deadline -> capture_timeout, not success", async () => {
    // The deadline must win permanently: a screenshot landing post-deadline
    // (here at ~1s vs a 300ms deadline) cannot resurrect the capture.
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => lateWriterBrowser, deadlineMs: 300 }),
    );
    expectFail(r, 500, "capture_timeout");
    expect(tmpLeftovers()).toEqual([]);
  });

  it("SIGTERM-ignoring child -> capture_timeout bounded by deadline + kill grace", async () => {
    const started = Date.now();
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => stubbornBrowser, deadlineMs: 400 }),
    );
    expectFail(r, 500, "capture_timeout");
    // SIGTERM at 400ms is ignored; SIGKILL lands after the 2s grace. The
    // documented bound is deadline + grace (+ scheduling slack).
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
    expect(tmpLeftovers()).toEqual([]);
  });
});

describe("preview-capture: happy path + concurrency", () => {
  it("returns a PNG with sanitized caption/filename (query stripped)", async () => {
    const r = await capturePreview(
      {
        url: "http://127.0.0.1:5173/rooms/dev?token=SECRET#frag",
        viewport: { width: 800, height: 600 },
        wait: 500,
      },
      deps(),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.error}`);
    expect(r.png.subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(r.caption).toBe("http://127.0.0.1:5173/rooms/dev");
    expect(r.caption).not.toContain("SECRET");
    expect(r.filename).toBe("preview-127.0.0.1-5173-rooms-dev.png");
    expect(tmpLeftovers()).toEqual([]);
  });

  it("browser that hangs AFTER writing the PNG -> success via poll-then-kill, well before the deadline", async () => {
    // Regression for the real-Chrome behavior observed on auntie: the
    // screenshot lands in a few seconds, then process teardown hangs 20s+.
    // Success must key off the complete file, not the exit.
    const started = Date.now();
    const r = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps({ findBrowser: () => hangingBrowser, deadlineMs: 15_000 }),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.error}`);
    // Poll interval is 100ms and the kill grace is 2s; anything near the
    // 15s deadline means we waited for the hang instead of killing.
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("third concurrent capture -> immediate 429 capture_busy; slots recover", async () => {
    const slow = deps({ findBrowser: () => slowBrowser, deadlineMs: 1_500 });
    const a = capturePreview({ url: "http://127.0.0.1:3000/" }, slow);
    const b = capturePreview({ url: "http://127.0.0.1:3000/" }, slow);
    // Let a/b get past pre-flight and take their slots.
    await new Promise((res) => setTimeout(res, 200));
    const c = await capturePreview({ url: "http://127.0.0.1:3000/" }, deps());
    expectFail(c, 429, "capture_busy");
    const [ra, rb] = await Promise.all([a, b]);
    expectFail(ra, 500, "capture_timeout");
    expectFail(rb, 500, "capture_timeout");
    // Slots released: a fresh capture succeeds.
    const again = await capturePreview(
      { url: "http://127.0.0.1:3000/" },
      deps(),
    );
    expect(again.ok).toBe(true);
    expect(tmpLeftovers()).toEqual([]);
  });
});
