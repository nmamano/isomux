// Browser preview capture - the engine behind POST /api/agents/:id/preview-url.
// It uses a Chrome-family headless CLI (zero bundled browser deps) so an agent
// can drop a page preview card into its chat.
//
// Shape notes:
//   - Any http(s) URL is accepted: the
//     original local/private-host input policy was dropped because it never
//     was an enforced network boundary - agents already have unrestricted
//     shell access, and Chrome resolves DNS independently (redirects and
//     subresources can go anywhere). The compensating control is the agent
//     system prompt, which tells agents the page renders in a real browser on
//     the server and to decline previews of suspicious/untrusted sites.
//     Syntax checks remain: http(s) only, no embedded credentials.
//   - Pre-flight fetch: the target receives TWO requests (this fetch, then
//     Chrome). Deliberate: it converts the overwhelmingly common failure (dev
//     server not running) into a precise `unreachable` error instead of a
//     screenshot of Chrome's own error page. Disclosed in the agent prompt.
//   - Past pre-flight, success means "Chrome produced a PNG" - which can be a
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
// Testable seam: capturePreview(body, deps) - findBrowser / fetchFn /
// deadlineMs are injectable (preview-capture.test.ts uses a fake shell-script
// "browser" via ISOMUX_PREVIEW_BROWSER / findBrowser, so the real spawn, group
// kill, and temp-dir cleanup paths run deterministically without Chrome).

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { accessSync, constants } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { spawn } from "child_process";
import type { AgentHost } from "./agent-host.ts";
import { NOT_READY_PATH } from "./member-hosts.ts";
import { parseUrlProbeReply, type UrlProbeReply } from "./preview-probe.ts";
import { errCode } from "../shared/errors.ts";

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
  png: Buffer<ArrayBuffer>;
  /** Sanitized provenance for the chat card: origin + pathname, query stripped. */
  caption: string;
  /** Generated attachment name - host/port/path only, never the query string. */
  filename: string;
}

export type PreviewResult = PreviewSuccess | PreviewFailure;

export interface PreviewCaptureDeps {
  /** Resolve the browser executable. Default: env override, PATH probe, then
   * the known absolute install paths. */
  findBrowser?: () => string | null;
  /** Pre-flight reachability fetch. Default: global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Overall capture deadline covering the pre-flight and the browser run
   * (queue-free by design: busy is an immediate 429). Termination starts
   * at the deadline; the call can return up to KILL_GRACE_MS later while a
   * stubborn browser is reaped - never before the child is dead.
   */
  deadlineMs?: number;
  /** Base dir for per-capture temp dirs. Default: os.tmpdir(). Tests inject
   * their own so "the temp dir was removed" is assertable without scanning
   * the shared system tmpdir. */
  tmpBase?: string;
  /**
   * Called after the pre-flight. For a URL on a registered app's host that the
   * agent may open, returns the URL Chrome navigates to instead (a single-use
   * sign-in for this capture) and a release() the capture calls when it ends.
   * Null keeps the plain URL. "refused" means the agent may open the app but
   * no grant could be minted: the capture fails rather than load the sign-in
   * page in the app's place. `expiresAt` is the latest time the capture can
   * still be loading.
   */
  appGrant?: (
    url: URL,
    expiresAt: number,
  ) => PreviewAppGrant | "refused" | null;
}

export interface PreviewAppGrant {
  navigateUrl: string;
  release: () => void;
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
// Absolute fallbacks, tried after the PATH names above. A systemd unit runs
// with a minimal PATH, so a browser can be installed and still be invisible to
// the name probe - /snap/bin (where Ubuntu 24.04 puts chromium) is never on it.
// Last resort on purpose: snap-confined chromium usually installs fine and then
// fails the capture itself, which at least surfaces the browser's own stderr
// instead of a flat "no browser found". On macOS, Chrome installs as an app
// bundle and puts nothing on PATH.
export const BROWSER_ABSOLUTE_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// A full Chrome process tree peaked at 188-208 MiB for typical pages and 403 MiB
// for the heaviest measured page on 2026-08-29. These cgroup memory.peak values
// include page cache, so they are upper bounds. There is no server queue: the
// deadline never hides unbounded wait, and a busy slot is an immediate 429.
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

function parsePreviewParams(body: unknown): ParsedParams | PreviewFailure {
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
  // The fragment stays: Chrome loads it, and hash-routed pages render from it.
  // The caption and filename drop it, with the query.

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

// Engine probe. ISOMUX_PREVIEW_BROWSER overrides for unusual install paths and
// for deterministic tests (a fake shell-script "browser"). Exported because
// Shared executable discovery for server screenshot previews.

function defaultFindBrowser(): string | null {
  const override = process.env.ISOMUX_PREVIEW_BROWSER;
  if (override) return override;
  for (const candidate of BROWSER_CANDIDATES) {
    const resolved = Bun.which(candidate);
    if (resolved) return resolved;
  }
  for (const path of BROWSER_ABSOLUTE_PATHS) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not installed here, or not executable by the service user
    }
  }
  return null;
}

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
// ourselves and await the exit before the caller cleans up the temp dir -
// killing first, cleaning later, so Chrome can't recreate files post-rm.

// PNG streams end with an IEND chunk: length(4) + "IEND"(4) + CRC(4).
const PNG_IEND = Buffer.from("IEND", "ascii");
function isCompletePng(data: Buffer): boolean {
  return (
    data.length > PNG_SIGNATURE.length + 12 &&
    data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    data.subarray(data.length - 8, data.length - 4).equals(PNG_IEND)
  );
}

const FILE_POLL_INTERVAL_MS = 100;

// The page the browser starts at: it goes on to `url` at once. The URL is
// a JSON string with "<" escaped, so no URL can end the script element.
export const START_PAGE = "go.html";
export function startPage(url: string): string {
  const target = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<!doctype html><script>location.replace(${target})</script>`;
}

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
          // The child is already dead; killing it is idempotent.
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
        return false;
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
          // Do not wait out Chrome's teardown hang after the screenshot is
          // complete. Kill the group and let the close handler resolve it.
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
      if (settled || fileDone) return;
      timedOut = true;
      if (pollTimer) clearInterval(pollTimer);
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
      // the deadline is still a timeout - the advertised contract must hold.
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

// The browser's argv for one capture.
function browserArgs(o: {
  outPath: string;
  profileDir: string;
  startPath: string;
  width: number;
  height: number;
  wait: number;
}): string[] {
  return [
    "--headless=new",
    `--screenshot=${o.outPath}`,
    `--window-size=${o.width},${o.height}`,
    // In --headless=new the page viewport is the window size MINUS an ~87px
    // virtual browser-UI strip, while --screenshot captures the full
    // window-sized canvas - pages that paint their background via
    // viewport-sized elements (100vh containers) get an unpainted white
    // band at the bottom. Fullscreen removes the virtual UI, but sizes the
    // window to the virtual SCREEN (default 800x600), not --window-size -
    // so pin the screen to the requested size too. Result: viewport ==
    // window == screen == canvas (verified empirically on Chrome 145,
    // 2026-07-12).
    `--screen-info={0,0 ${o.width}x${o.height}}`,
    "--start-fullscreen",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    // Puppeteer-style automation flags: full Chrome otherwise runs its
    // phone-home background services (optimization-guide model downloads,
    // component updater, sync/signin) on every fresh profile, which was
    // observed to stall captures by 20s+ on a box with slow egress - and to
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
    `--user-data-dir=${o.profileDir}`,
    ...(o.wait > 0 ? [`--virtual-time-budget=${o.wait}`] : []),
    // Always last: a file:// URL, so it can never be parsed as a flag.
    // argv holds no page URL. Every user of the box can read a process's
    // argv, and a URL can carry a token (a grant's sign-in code, a query).
    // The URL is in the 0600 start page that only the capturing user reads.
    pathToFileURL(o.startPath).href,
  ];
}

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

function noBrowser(): PreviewFailure {
  return fail(
    500,
    "no_browser",
    `no Chrome-family browser found (tried ${BROWSER_CANDIDATES.join(", ")} on PATH, ` +
      `then ${BROWSER_ABSOLUTE_PATHS.join(", ")}); ` +
      "install one or point ISOMUX_PREVIEW_BROWSER at an executable",
  );
}

function captureBusy(): PreviewFailure {
  return fail(
    429,
    "capture_busy",
    `${MAX_CONCURRENT_CAPTURES} captures already in progress; retry in a few seconds`,
  );
}

/**
 * Validate, pre-flight, and capture a screenshot of `body.url`.
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
  // synchronous parse) bounds the pre-flight and the browser run. On expiry,
  // termination STARTS at the deadline; the response can then take up to
  // KILL_GRACE_MS longer while a stubborn browser is SIGKILLed and reaped -
  // we never return before the child is dead, so the temp-dir cleanup can't
  // race a live Chrome. Net: response ≤ deadline + 2s.
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;

  const findBrowser = deps.findBrowser ?? defaultFindBrowser;
  const executable = findBrowser();
  if (!executable) return noBrowser();

  if (activeCaptures >= MAX_CONCURRENT_CAPTURES) return captureBusy();
  activeCaptures++;

  const fetchFn = deps.fetchFn ?? fetch;
  let tmpDir: string | null = null;
  let grant: PreviewAppGrant | null = null;
  try {
    // Pre-flight: any HTTP response (any status) counts as reachable; only
    // network-level failure is an error. Costs the target a duplicate GET -
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
        `\`${url}\` is not responding (${err instanceof Error ? err.message : String(err)}) - is the server running?`,
      );
    }

    // After the pre-flight, so the pre-flight never carries the grant.
    const granted = deps.appGrant?.(url, deadline + KILL_GRACE_MS) ?? null;
    if (granted === "refused") {
      return fail(
        429,
        "capture_busy",
        "too many app screenshots from this agent; retry in a minute",
      );
    }
    grant = granted;

    tmpDir = await mkdtemp(join(deps.tmpBase ?? tmpdir(), "isomux-preview-"));
    const outPath = join(tmpDir, "shot.png");
    const startPath = join(tmpDir, START_PAGE);
    await writeFile(
      startPath,
      startPage(grant?.navigateUrl ?? url.toString()),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    const args = browserArgs({
      outPath,
      profileDir: tmpDir,
      startPath,
      width,
      height,
      wait,
    });

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

    let png: Buffer<ArrayBuffer>;
    try {
      // fs.readFile allocates a process-owned ArrayBuffer, never a
      // SharedArrayBuffer. Keep that true backing type through the preview
      // result instead of widening it to Buffer<ArrayBufferLike>.
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
        `screenshot is ${(png.length / (1024 * 1024)).toFixed(1)} MB - over the ${MAX_PNG_BYTES / (1024 * 1024)} MB cap`,
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
    grant?.release();
    if (tmpDir) {
      // A cleanup failure must not fail an already-emitted card, but leaked
      // Chrome profiles eat disk - make it observable. tmpDir carries no URL.
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

// ---------------------------------------------------------------------------
// A capture for an agent of an isolated member (internal-docs/
// member-os-user-design.md, part 2b): the pre-flight, the browser and every
// file of the capture are the member's, through their host. The office makes
// no request to the URL and never reads a file of the capture with its own
// fs; the PNG comes only through the host's bounded read.

export interface PreviewHostDeps {
  findBrowser?: () => string | null;
  deadlineMs?: number;
  appGrant?: PreviewCaptureDeps["appGrant"];
  // The poll interval of the screenshot file. Tests shorten it.
  pollMs?: number;
}

type HostRunOutcome =
  | { kind: "captured"; png: Buffer<ArrayBuffer> }
  | { kind: "too_big"; size: number }
  | { kind: "exited"; exitCode: number | null; stderrTail: string }
  | { kind: "timeout" }
  | { kind: "spawn_error"; message: string };

// The browser run on a member host. As runBrowser, with these differences:
// the poll stats the file and reads its bytes only when its (size, mtime,
// inode) was the same at two polls and is not a file already read and found
// incomplete; the bytes it returns are the only read of the screenshot; the
// browser is stopped only through the host (signalGroup), never by a pid,
// which is member data; and it settles only at the child's "close", so the
// caller removes the profile when no browser can write to it.
function runBrowserOnHost(
  host: AgentHost,
  executable: string,
  args: string[],
  cwd: string,
  outPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<HostRunOutcome> {
  return new Promise((resolve) => {
    const child = host.spawnChild([executable, ...args], {
      cwd,
      env: host.baseEnv(),
      stderr: "pipe",
    });
    // Drained: a runner child's unread stdout pauses its whole stream, the
    // exit report too (agent-runner/client.ts).
    child.stdout.on("data", () => {});
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    let settled = false;
    let timedOut = false;
    let stopping = false;
    let png: Buffer<ArrayBuffer> | null = null;
    let tooBig: number | null = null;
    let spawnError: string | null = null;
    let lastKey: string | null = null;
    let seen = 0;
    let incompleteKey: string | null = null;
    let polling = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      pollTimer = killTimer = graceTimer = null;
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      child.signalGroup("SIGTERM");
      graceTimer = setTimeout(
        () => child.signalGroup("SIGKILL"),
        KILL_GRACE_MS,
      );
    };
    // The bytes of a complete screenshot, or null; "big" over the cap.
    const readComplete = async (): Promise<
      Buffer<ArrayBuffer> | "big" | null
    > => {
      try {
        const bytes = await host.fs.readBytes(outPath, MAX_PNG_BYTES);
        // A copy in a process-owned ArrayBuffer, as PreviewSuccess.png is.
        return isCompletePng(bytes) ? Buffer.from(bytes) : null;
      } catch (err) {
        return errCode(err) === "EFBIG" ? "big" : null;
      }
    };
    const poll = async () => {
      let stat;
      try {
        stat = await host.fs.stat(outPath);
      } catch {
        return;
      }
      if (stat.type !== "file") return;
      if (stat.size > MAX_PNG_BYTES) {
        tooBig = stat.size;
        return stop();
      }
      const key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      seen = key === lastKey ? seen + 1 : 1;
      lastKey = key;
      if (seen < 2 || key === incompleteKey) return;
      const read = await readComplete();
      if (settled || timedOut || stopping) return;
      if (read === "big") {
        tooBig = stat.size;
        return stop();
      }
      if (read) {
        png = read;
        return stop();
      }
      incompleteKey = key;
    };
    pollTimer = setInterval(() => {
      if (polling || settled || stopping) return;
      polling = true;
      void poll().finally(() => {
        polling = false;
      });
    }, pollMs);
    killTimer = setTimeout(() => {
      if (settled || stopping) return;
      timedOut = true;
      stop();
    }, timeoutMs);

    const settle = (outcome: HostRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(outcome);
    };
    child.on("error", (err: Error) => {
      spawnError = err.message;
      // No process ever ran: nothing can write to the profile.
      if (child.pid === undefined)
        settle({ kind: "spawn_error", message: spawnError });
    });
    child.on("close", (code: number | null) => {
      // Priority, as runBrowser: timeout > captured > the rest.
      if (timedOut) return settle({ kind: "timeout" });
      if (png) return settle({ kind: "captured", png });
      if (tooBig !== null) return settle({ kind: "too_big", size: tooBig });
      if (spawnError !== null)
        return settle({ kind: "spawn_error", message: spawnError });
      const tail = stderr
        .replace(/\s*\n\s*/g, " | ")
        .trim()
        .slice(-STDERR_TAIL_CHARS);
      // A clean exit can race the poll: one last bounded read.
      void readComplete().then((read) => {
        if (read === "big")
          settle({ kind: "too_big", size: MAX_PNG_BYTES + 1 });
        else if (read) settle({ kind: "captured", png: read });
        else settle({ kind: "exited", exitCode: code, stderrTail: tail });
      });
    });
  });
}

// A random name for one capture's profile folder.
function captureDirName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * capturePreview for an agent of an isolated member: `host` is the member's
 * host (hostFor of the agent's manager). The same parse, deadline, busy slot,
 * results and texts as capturePreview.
 */
export async function capturePreviewOnHost(
  body: unknown,
  host: AgentHost,
  deps: PreviewHostDeps = {},
): Promise<PreviewResult> {
  const parsed = parsePreviewParams(body);
  if (!parsed.ok) return parsed;
  const { url, width, height, wait } = parsed;
  // Before the busy slot and before any call to the runner.
  if (host.agentRoot() === NOT_READY_PATH)
    return fail(
      500,
      "capture_failed",
      "your manager's OS user is not ready; retry later",
    );
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  const executable = (deps.findBrowser ?? defaultFindBrowser)();
  if (!executable) return noBrowser();
  if (activeCaptures >= MAX_CONCURRENT_CAPTURES) return captureBusy();
  activeCaptures++;

  let dir: string | null = null;
  let grant: PreviewAppGrant | null = null;
  try {
    // The pre-flight, as the member: the office user makes no request to
    // the URL. A runner that fails or answers out of shape gets a fixed text.
    const timeoutMs = Math.max(
      1,
      Math.min(PREFLIGHT_TIMEOUT_MS, deadline - Date.now()),
    );
    let probe: UrlProbeReply | null = null;
    try {
      probe = parseUrlProbeReply(
        await host.runEntry(
          "url-probe",
          { url: url.toString(), timeoutMs },
          timeoutMs + 1_000,
        ),
      );
    } catch {
      probe = null;
    }
    if (!probe)
      return fail(
        500,
        "unreachable",
        `could not check whether \`${url}\` responds; retry later`,
      );
    if (!probe.reachable)
      return fail(
        500,
        "unreachable",
        `\`${url}\` is not responding (${probe.error}) - is the server running?`,
      );

    // After the pre-flight, so the pre-flight never carries the grant.
    const granted = deps.appGrant?.(url, deadline + KILL_GRACE_MS) ?? null;
    if (granted === "refused") {
      return fail(
        429,
        "capture_busy",
        "too many app screenshots from this agent; retry in a minute",
      );
    }
    grant = granted;

    // The member's profile folder, 0700, with the start page (0600): the
    // URL, and a grant's sign-in code, are in no process's argv.
    dir = join(host.agentRoot(), "preview", captureDirName());
    const outPath = join(dir, "shot.png");
    const startPath = join(dir, START_PAGE);
    try {
      await host.fs.mkdir(dir, 0o700);
      await host.fs.writeText(
        startPath,
        startPage(grant?.navigateUrl ?? url.toString()),
        { mode: 0o600, exclusive: true },
      );
    } catch (err) {
      return fail(
        500,
        "capture_failed",
        `could not make the capture folder (${errCode(err) ?? "error"})`,
      );
    }
    const args = browserArgs({
      outPath,
      profileDir: dir,
      startPath,
      width,
      height,
      wait,
    });

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return fail(500, "capture_timeout", `capture exceeded ${deadlineMs}ms`);
    }
    const outcome = await runBrowserOnHost(
      host,
      executable,
      args,
      dir,
      outPath,
      remaining,
      deps.pollMs ?? FILE_POLL_INTERVAL_MS,
    );
    switch (outcome.kind) {
      case "timeout":
        return fail(500, "capture_timeout", `capture exceeded ${deadlineMs}ms`);
      case "spawn_error":
        return fail(
          500,
          "capture_failed",
          `failed to launch \`${executable}\`: ${outcome.message}`,
        );
      case "too_big":
        return fail(
          500,
          "capture_failed",
          `screenshot is ${(outcome.size / (1024 * 1024)).toFixed(1)} MB - over the ${MAX_PNG_BYTES / (1024 * 1024)} MB cap`,
        );
      case "exited": {
        const stderrSuffix = outcome.stderrTail
          ? ` (browser stderr: ${outcome.stderrTail})`
          : "";
        if (outcome.exitCode !== 0)
          return fail(
            500,
            "capture_failed",
            `browser exited with code ${outcome.exitCode ?? "null"}${stderrSuffix}`,
          );
        const wroteSomething = await host.fs.exists(outPath).catch(() => false);
        return fail(
          500,
          "capture_failed",
          wroteSomething
            ? `browser produced an invalid screenshot${stderrSuffix}`
            : `browser produced no screenshot${stderrSuffix}`,
        );
      }
    }
    return {
      ok: true,
      png: outcome.png,
      caption: `${url.origin}${url.pathname}`,
      filename: previewFilename(url),
    };
  } finally {
    activeCaptures--;
    grant?.release();
    // runBrowserOnHost settles only after the browser closed. A fixed argv
    // with a folder the server named under the member's agent space.
    if (dir) await removeCaptureDir(host, dir);
  }
}

async function removeCaptureDir(host: AgentHost, dir: string): Promise<void> {
  let left = true;
  try {
    await host.run(["rm", "-rf", "--", dir], { output: "ignore" });
    left = await host.fs.exists(dir);
  } catch {
    left = true;
  }
  if (left)
    console.warn(
      `[preview-capture] failed to remove the member's capture folder ${dir}`,
    );
}
