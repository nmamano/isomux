// Browser preview capture — the engine behind POST /api/agents/:id/preview-url
// (task dcfd5a97). Screenshots a local/private URL with a Chrome-family headless
// CLI (zero bundled browser deps) so an agent can drop a page preview card into
// its chat. Design doc: reviewed by Reviewer5, approved by Nil 2026-07-12.
//
// Shape notes frozen by that review:
//   - The host check is an INPUT POLICY, not an enforced network boundary:
//     agents already have unrestricted shell access, and Chrome resolves DNS
//     independently after our one-time lookup (redirects/subresources can go
//     anywhere). We scope the feature to local/private dev servers; we do not
//     claim SSRF enforcement.
//   - Pre-flight fetch: the target receives TWO requests (this fetch, then
//     Chrome). Deliberate: it converts the overwhelmingly common failure (dev
//     server not running) into a precise `unreachable` error instead of a
//     screenshot of Chrome's own error page. Disclosed in the agent prompt.
//   - Past pre-flight, success means "Chrome produced a PNG" — which can be a
//     rendered error page (e.g. the app's 500 page). Chrome's CLI exits 0 on
//     navigation errors, so exit codes cannot distinguish those.
//   - `wait` maps to --virtual-time-budget: a best-effort render budget that
//     fast-forwards page timers, NOT a wall-clock sleep (the CLI has no
//     post-load sleep surface).
//   - Strict validation, no silent clamping: out-of-range values are 400s so
//     callers never misread what the image shows.
//   - All failure statuses fit the executor's HandlerErrorStatus union
//     (400/429/500); distinct `code`s carry the failure kind.
//
// Testable seam: capturePreview(body, deps) — findBrowser / fetchFn / lookupFn /
// deadlineMs are injectable (preview-capture.test.ts uses a fake shell-script
// "browser" via ISOMUX_PREVIEW_BROWSER / findBrowser, so the real spawn, group
// kill, and temp-dir cleanup paths run deterministically without Chrome).

import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { lookup } from "dns/promises";
import { isIP } from "net";

export type PreviewErrorCode =
  | "invalid_request"
  | "capture_busy"
  | "no_browser"
  | "unreachable"
  | "capture_failed"
  | "capture_timeout";

export interface PreviewFailure {
  ok: false;
  status: 400 | 429 | 500;
  code: PreviewErrorCode;
  error: string;
}

export interface PreviewSuccess {
  ok: true;
  png: Buffer;
  /** Sanitized provenance for the chat card: origin + pathname, query stripped. */
  caption: string;
  /** Generated attachment name — host/port/path only, never the query string. */
  filename: string;
}

export type PreviewResult = PreviewSuccess | PreviewFailure;

export interface PreviewCaptureDeps {
  /** Resolve the browser executable. Default: env override, then PATH probe. */
  findBrowser?: () => string | null;
  /** Pre-flight reachability fetch. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** DNS resolution for the input policy check. Default: dns.promises.lookup. */
  lookupFn?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Overall capture deadline covering DNS policy, pre-flight, and the browser
   * run (queue-free by design: busy is an immediate 429). Termination starts
   * at the deadline; the call can return up to KILL_GRACE_MS later while a
   * stubborn browser is reaped — never before the child is dead.
   */
  deadlineMs?: number;
  /** Base dir for per-capture temp dirs. Default: os.tmpdir(). Tests inject
   * their own so "the temp dir was removed" is assertable without scanning
   * the shared system tmpdir. */
  tmpBase?: string;
}

const MAX_URL_LEN = 2048;
const MIN_DIM = 320;
const MAX_DIM = 2560;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MAX_WAIT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 20_000;
const PREFLIGHT_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 2_000;
// Matches read-file's display cap; the persistence layer's own 200MB backstop
// must not be the effective bound for screenshots.
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const STDERR_TAIL_CHARS = 500;
const MAX_CONCURRENT_CAPTURES = 2;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const BROWSER_CANDIDATES = [
  "google-chrome",
  "chromium",
  "chromium-browser",
];

// Each Chrome is briefly ~150MB RSS; no queueing so the deadline never hides
// unbounded wait time — a busy slot is an immediate 429 and agents retry.
let activeCaptures = 0;

function fail(
  status: PreviewFailure["status"],
  code: PreviewErrorCode,
  error: string,
): PreviewFailure {
  return { ok: false, status, code, error };
}

function invalid(error: string): PreviewFailure {
  return fail(400, "invalid_request", error);
}

interface ParsedParams {
  ok: true;
  url: URL;
  width: number;
  height: number;
  wait: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parsePreviewParams(
  body: unknown,
): ParsedParams | PreviewFailure {
  if (!isPlainObject(body)) return invalid("body must be a JSON object");
  const rawUrl = body.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0)
    return invalid("url is required");
  if (rawUrl.length > MAX_URL_LEN)
    return invalid(`url too long (max ${MAX_URL_LEN} chars)`);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return invalid(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return invalid("only http:// and https:// URLs are supported");
  if (url.username || url.password)
    return invalid("URLs with embedded credentials are not allowed");
  url.hash = ""; // fragments are meaningless to a fresh page load

  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  if (body.viewport !== undefined) {
    if (!isPlainObject(body.viewport))
      return invalid("viewport must be an object {width, height}");
    const { width: w, height: h } = body.viewport;
    if (
      typeof w !== "number" ||
      typeof h !== "number" ||
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < MIN_DIM ||
      w > MAX_DIM ||
      h < MIN_DIM ||
      h > MAX_DIM
    ) {
      return invalid(
        `viewport width/height must be integers in ${MIN_DIM}..${MAX_DIM}`,
      );
    }
    width = w;
    height = h;
  }

  let wait = 0;
  if (body.wait !== undefined) {
    if (
      typeof body.wait !== "number" ||
      !Number.isInteger(body.wait) ||
      body.wait < 0 ||
      body.wait > MAX_WAIT_MS
    ) {
      return invalid(`wait must be an integer in 0..${MAX_WAIT_MS} (ms)`);
    }
    wait = body.wait;
  }

  return { ok: true, url, width, height, wait };
}

// ---------------------------------------------------------------------------
// Input policy: local/private hosts only (loopback, RFC1918, tailscale CGNAT,
// link-local, ULA). Named hosts (including single-label like `auntie`) are
// resolved and EVERY answer must fall in the allowed sets — mixed records are
// rejected. IPv4-mapped IPv6 is unwrapped before checking.

function ipv4Allowed(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10) return true; // loopback, RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (tailscale)
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

// Expand an IPv6 literal into its 8 16-bit groups (handles `::` compression
// and embedded dotted-quad tails like `::ffff:1.2.3.4`). Returns null on
// malformed input — callers treat null as "not allowed", the safe direction.
function parseIpv6Groups(ip: string): number[] | null {
  const dc = ip.indexOf("::");
  let head = ip;
  let tail = "";
  if (dc !== -1) {
    head = ip.slice(0, dc);
    tail = ip.slice(dc + 2);
    if (tail.includes("::")) return null; // at most one compression
  }
  const parseSide = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        if (v4.length !== 4) return null;
        if (v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
          return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const h = parseSide(head);
  const t = parseSide(tail);
  if (!h || !t) return null;
  if (dc === -1) return h.length === 8 ? h : null;
  const fill = 8 - h.length - t.length;
  if (fill < 1) return null;
  return [...h, ...Array<number>(fill).fill(0), ...t];
}

function ipv6Allowed(ip: string): boolean {
  const g = parseIpv6Groups(ip.toLowerCase());
  if (!g) return false;
  // IPv4-mapped (::ffff:0:0/96) in ANY textual form — dotted (::ffff:1.2.3.4)
  // or hex (::ffff:7f00:1) — unwraps to the v4 policy.
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    return ipv4Allowed(
      `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`,
    );
  }
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  return false;
}

function addressAllowed(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Allowed(address);
  if (family === 6) return ipv6Allowed(address);
  return false;
}

const BLOCKED_HOST_MSG =
  "preview is for local/private dev servers (localhost, LAN, tailscale); public URLs are rejected";

// Sentinel rejection for withBudget so callers can map deadline exhaustion to
// capture_timeout distinctly from the operation's own failure.
class BudgetExceeded extends Error {}

// Race a promise against the remaining deadline budget. dns.promises.lookup
// has no timeout of its own, so an unbounded resolver would otherwise hold the
// request past the advertised deadline.
function withBudget<T>(p: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BudgetExceeded()),
      Math.max(1, budgetMs),
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function checkHostPolicy(
  url: URL,
  lookupFn: NonNullable<PreviewCaptureDeps["lookupFn"]>,
  budgetMs: number,
): Promise<PreviewFailure | null> {
  // URL.hostname keeps IPv6 brackets and can carry a trailing dot; normalize.
  let host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  host = host.toLowerCase();
  if (isIP(host)) {
    return addressAllowed(host) ? null : invalid(BLOCKED_HOST_MSG);
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await withBudget(lookupFn(host), budgetMs);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return fail(
        500,
        "capture_timeout",
        `DNS resolution of \`${host}\` exceeded the capture deadline`,
      );
    }
    return fail(
      500,
      "unreachable",
      `could not resolve host \`${host}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (answers.length === 0) {
    return fail(500, "unreachable", `host \`${host}\` did not resolve`);
  }
  return answers.every((a) => addressAllowed(a.address))
    ? null
    : invalid(BLOCKED_HOST_MSG);
}

// ---------------------------------------------------------------------------
// Engine probe. ISOMUX_PREVIEW_BROWSER overrides for unusual install paths and
// for deterministic tests (a fake shell-script "browser").

function defaultFindBrowser(): string | null {
  const override = process.env.ISOMUX_PREVIEW_BROWSER;
  if (override) return override;
  for (const candidate of BROWSER_CANDIDATES) {
    const resolved = Bun.which(candidate);
    if (resolved) return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome run: detached spawn (own process group), group kill on deadline with
// SIGKILL escalation, timers cleared on observed exit, ENOENT handled even
// after a successful probe (probe-to-spawn races), kill idempotent.
//
// Success is "a complete PNG exists", NOT "Chrome exited cleanly": full Chrome
// writes the screenshot within a few seconds but its process teardown can then
// hang 20s+ (observed on auntie 2026-07-12: the file was written at ~4s and a
// lingering background-service/QUIC shutdown held the process for another
// ~21s). So we poll for the finished file (PNG signature + IEND trailer, which
// Chrome only writes once the image is complete), then kill the group
// ourselves and await the exit before the caller cleans up the temp dir —
// killing first, cleaning later, so Chrome can't recreate files post-rm.

// PNG streams end with an IEND chunk: length(4) + "IEND"(4) + CRC(4).
const PNG_IEND = Buffer.from("IEND", "ascii");
export function isCompletePng(data: Buffer): boolean {
  return (
    data.length > PNG_SIGNATURE.length + 12 &&
    data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    data.subarray(data.length - 8, data.length - 4).equals(PNG_IEND)
  );
}

const FILE_POLL_INTERVAL_MS = 100;

type BrowserRunOutcome =
  | { kind: "captured" } // complete PNG on disk; child killed and reaped
  | { kind: "exited"; exitCode: number | null; stderrTail: string }
  | { kind: "timeout" }
  | { kind: "spawn_error"; message: string };

function runBrowser(
  executable: string,
  args: string[],
  outPath: string,
  timeoutMs: number,
): Promise<BrowserRunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      detached: true, // own process group so -pid kills Chrome's helpers too
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    let settled = false;
    let timedOut = false;
    let fileDone = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let polling = false;

    const killGroup = (signal: NodeJS.Signals) => {
      // Negative-PID signal ONLY when the group exists: pid is set iff the
      // detached spawn succeeded (spawn 'error' fires with pid undefined).
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal); // group already gone or not a leader; best effort
        } catch {
          // already dead — kill is idempotent by being a no-op here
        }
      }
    };

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (pollTimer) clearInterval(pollTimer);
      killTimer = null;
      graceTimer = null;
      pollTimer = null;
    };

    const checkFile = async (): Promise<boolean> => {
      try {
        return isCompletePng(await readFile(outPath));
      } catch {
        return false; // not there yet
      }
    };

    // Whichever fires first wins PERMANENTLY: a poll that completes after
    // `timedOut` is set must not resurrect the capture as a success, and a
    // deadline that fires after `fileDone` must not demote it to a timeout.
    pollTimer = setInterval(() => {
      if (polling || settled || fileDone || timedOut) return;
      polling = true;
      void checkFile()
        .then((done) => {
          polling = false;
          if (!done || settled || fileDone || timedOut) return;
          // Screenshot complete: don't wait out Chrome's teardown hang — kill
          // the group and let the 'close' handler resolve as captured.
          fileDone = true;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          killGroup("SIGTERM");
          graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        })
        .catch(() => {
          polling = false;
        });
    }, FILE_POLL_INTERVAL_MS);

    killTimer = setTimeout(() => {
      if (settled || fileDone) return; // capture already won
      timedOut = true;
      if (pollTimer) clearInterval(pollTimer); // stop polling; timeout won
      pollTimer = null;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ kind: "spawn_error", message: err.message });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Priority: timeout > captured > exited. A screenshot that lands after
      // the deadline is still a timeout — the advertised contract must hold.
      if (timedOut) {
        resolve({ kind: "timeout" });
        return;
      }
      if (fileDone) {
        resolve({ kind: "captured" });
        return;
      }
      const tail = stderr
        .replace(/\s*\n\s*/g, " | ")
        .trim()
        .slice(-STDERR_TAIL_CHARS);
      // A normal exit can race the poll: give the file one final check so a
      // fast clean run isn't misread as a failure.
      void checkFile().then((done) => {
        if (done) {
          resolve({ kind: "captured" });
        } else {
          resolve({ kind: "exited", exitCode: code, stderrTail: tail });
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------

function previewFilename(url: URL): string {
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const slug = url.pathname
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `preview-${host}-${port}${slug ? `-${slug}` : ""}.png`;
}

/**
 * Validate, policy-check, pre-flight, and capture a screenshot of `body.url`.
 * Returns the PNG plus a sanitized caption/filename; never throws for expected
 * failures (they come back as structured PreviewFailure values).
 */
export async function capturePreview(
  body: unknown,
  deps: PreviewCaptureDeps = {},
): Promise<PreviewResult> {
  const parsed = parsePreviewParams(body);
  if (!parsed.ok) return parsed;
  const { url, width, height, wait } = parsed;

  // Deadline contract: ONE absolute deadline from here (right after the
  // synchronous parse) bounds DNS policy resolution, pre-flight, and the
  // browser run. On expiry, termination STARTS at the deadline; the response
  // can then take up to KILL_GRACE_MS longer while a stubborn browser is
  // SIGKILLed and reaped — we never return before the child is dead, so the
  // temp-dir cleanup can't race a live Chrome. Net: response ≤ deadline + 2s.
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;

  const lookupFn =
    deps.lookupFn ?? ((host: string) => lookup(host, { all: true }));
  const policyFailure = await checkHostPolicy(
    url,
    lookupFn,
    deadline - Date.now(),
  );
  if (policyFailure) return policyFailure;

  const findBrowser = deps.findBrowser ?? defaultFindBrowser;
  const executable = findBrowser();
  if (!executable) {
    return fail(
      500,
      "no_browser",
      `no Chrome-family browser found on PATH (tried ${BROWSER_CANDIDATES.join(", ")}); ` +
        "install one or point ISOMUX_PREVIEW_BROWSER at an executable",
    );
  }

  if (activeCaptures >= MAX_CONCURRENT_CAPTURES) {
    return fail(
      429,
      "capture_busy",
      `${MAX_CONCURRENT_CAPTURES} captures already in progress; retry in a few seconds`,
    );
  }
  activeCaptures++;

  const fetchFn = deps.fetchFn ?? fetch;
  let tmpDir: string | null = null;
  try {
    // Pre-flight: any HTTP response (any status) counts as reachable; only
    // network-level failure is an error. Costs the target a duplicate GET —
    // disclosed tradeoff for a precise "server not running" message.
    const preflightMs = Math.min(
      PREFLIGHT_TIMEOUT_MS,
      Math.max(1, deadline - Date.now()),
    );
    try {
      const res = await fetchFn(url.toString(), {
        signal: AbortSignal.timeout(preflightMs),
        redirect: "follow",
      });
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      return fail(
        500,
        "unreachable",
        `\`${url}\` is not responding (${err instanceof Error ? err.message : String(err)}) — is the server running?`,
      );
    }

    tmpDir = await mkdtemp(join(deps.tmpBase ?? tmpdir(), "isomux-preview-"));
    const outPath = join(tmpDir, "shot.png");
    const args = [
      "--headless=new",
      `--screenshot=${outPath}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // Puppeteer-style automation flags: full Chrome otherwise runs its
      // phone-home background services (optimization-guide model downloads,
      // component updater, sync/signin) on every fresh profile, which was
      // observed to stall captures by 20s+ on a box with slow egress — and to
      // keep WebSocket-heavy pages from ever settling.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-client-side-phishing-detection",
      "--disable-domain-reliability",
      "--metrics-recording-only",
      "--disable-features=OptimizationHints,MediaRouter,Translate",
      // THE critical pair on headless servers (found by observation on auntie,
      // 2026-07-12): without them Chrome consults the OS keyring over D-Bus,
      // and with no desktop session that call hangs until the ~25s D-Bus
      // method timeout on EVERY capture (measured 25.2s → 0.33s with them).
      "--password-store=basic",
      "--use-mock-keychain",
      // Fresh profile per capture: guarantees a Chrome process we own (no
      // reuse of a running instance), safe under concurrency.
      `--user-data-dir=${tmpDir}`,
      ...(wait > 0 ? [`--virtual-time-budget=${wait}`] : []),
      // Always last, and always scheme-prefixed (URL.toString()), so it can
      // never be parsed as a flag.
      url.toString(),
    ];

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return fail(500, "capture_timeout", `capture exceeded ${deadlineMs}ms`);
    }
    const outcome = await runBrowser(executable, args, outPath, remaining);
    if (outcome.kind === "timeout") {
      return fail(500, "capture_timeout", `capture exceeded ${deadlineMs}ms`);
    }
    if (outcome.kind === "spawn_error") {
      return fail(
        500,
        "capture_failed",
        `failed to launch \`${executable}\`: ${outcome.message}`,
      );
    }
    if (outcome.kind === "exited") {
      // Child gone with no complete PNG on disk (runBrowser already re-checked
      // the file post-exit). Distinguish "wrote garbage" from "wrote nothing"
      // for the error message.
      const stderrSuffix = outcome.stderrTail
        ? ` (browser stderr: ${outcome.stderrTail})`
        : "";
      if (outcome.exitCode !== 0) {
        return fail(
          500,
          "capture_failed",
          `browser exited with code ${outcome.exitCode ?? "null"}${stderrSuffix}`,
        );
      }
      const wroteSomething = await readFile(outPath).then(
        () => true,
        () => false,
      );
      return fail(
        500,
        "capture_failed",
        wroteSomething
          ? `browser produced an invalid screenshot${stderrSuffix}`
          : `browser produced no screenshot${stderrSuffix}`,
      );
    }

    // outcome.kind === "captured": a complete PNG is on disk.
    let png: Buffer;
    try {
      png = await readFile(outPath);
    } catch (err) {
      return fail(
        500,
        "capture_failed",
        `screenshot vanished before it could be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (png.length > MAX_PNG_BYTES) {
      return fail(
        500,
        "capture_failed",
        `screenshot is ${(png.length / (1024 * 1024)).toFixed(1)} MB — over the ${MAX_PNG_BYTES / (1024 * 1024)} MB cap`,
      );
    }

    return {
      ok: true,
      png,
      caption: `${url.origin}${url.pathname}`,
      filename: previewFilename(url),
    };
  } finally {
    activeCaptures--;
    if (tmpDir) {
      // A cleanup failure must not fail an already-emitted card, but leaked
      // Chrome profiles eat disk — make it observable. tmpDir carries no URL.
      await rm(tmpDir, { recursive: true, force: true }).catch(
        (err: unknown) => {
          console.warn(
            `[preview-capture] failed to remove temp dir ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }
}
