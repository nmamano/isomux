// Agent browser sessions - the engine behind POST /api/agents/:id/browser.
//
// preview-capture.ts screenshots a page and stops. This module keeps a page
// open so an agent can read it, click it and fill it. The two share one browser
// resolution rule (findBrowser below re-exports preview-capture's probe), so
// ISOMUX_PREVIEW_BROWSER still points both at the same executable.
//
// Shape notes:
//   - ONE browser for the whole office, ONE BrowserContext per agent. Measured
//     on this box 2026-09-05 (Chrome 151.0.7922.137, PSS over the process
//     tree): the browser costs about 350 MB before any context, and each
//     context adds about 160-220 MB. Six agents therefore cost about 1.3 GB
//     shared against about 3.4 GB with a browser each, because a browser each
//     pays the 350 MB again every time. See
//     internal-docs/browser-use-exploration.md section 8.
//   - One storage-state profile per member lives under the isomux state root.
//     Agents of that member share its cookies, local storage, IndexedDB and
//     virtual WebAuthn credentials; agents of another member never load it.
//     Contexts still die with the idle timer, then merge their changes into the
//     latest profile under a per-member queue so a stale close cannot erase a
//     login another agent added.
//   - Chrome keeps its own sandbox. `--no-sandbox` is NOT passed: pages here are
//     untrusted by design, and the sandbox is what stands between a hostile page
//     and this box. Verified working on auntie 2026-09-05.
//   - http(s) only, and no embedded credentials, checked before Playwright is
//     called. That check covers the URL the agent passes; a page navigates
//     itself afterwards, and Chrome is what refuses a later file:// navigation
//     (measured 2026-09-05 against Chrome 151: a file:// link click, a scripted
//     file:// navigation, and a 302 to file:// were all refused). There is NO
//     origin policy: a page reaches any other http(s) origin, as it does for a
//     person following a link. An allowlist would be a human-approval gate in a
//     different coat, which the project's design philosophy rules out.
//   - Downloads are refused at the context (`acceptDownloads: false`), so a page
//     cannot write to the disk through the browser.
//   - Every action returns the page's current url and title. A click that
//     navigates therefore tells the agent where it landed without a second call.
//   - ONE page per agent. A window the site opens becomes the agent's page and
//     the previous one closes, so a site that opens a window on every click
//     cannot grow the context. Two live pages would multiply the per-context
//     cost the shared-browser case is argued from.
//   - Two serialization points, and the lock order is fixed: the per-agent queue
//     first (see serialize), the office-wide lifecycle chain second (see
//     lifecycle). Concurrency here is not a throughput question - without the
//     first, two cold calls for one agent each build a context and one leaks;
//     without the second, one agent's close takes the shared browser down under
//     another agent that is mid-newContext. Page actions stay concurrent across
//     agents.
//
// Testable seam: browserActionDeps - launch / findBrowser / idleMs are
// injectable, so the pool logic (reuse, per-agent isolation, idle close) runs in
// tests with a stub browser and no Chrome.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { defaultFindBrowser, BROWSER_CANDIDATES } from "./preview-capture.ts";
import { BROWSER_MIN_DIM, BROWSER_MAX_DIM, type BrowserHumanInput, type BrowserNavigation } from "../shared/types.ts";

/** How long an agent's context survives with no browser call. */
export const BROWSER_IDLE_MS = 5 * 60 * 1000;
/**
 * Per-operation timeout handed to Playwright itself, so the operation aborts
 * rather than being abandoned. The pool adds a backstop above it (see
 * `backstopMs`) for the case where Playwright does not return at all.
 */
export const BROWSER_ACTION_DEADLINE_MS = 30_000;
/** How far the backstop sits above the Playwright timeout. */
const BACKSTOP_MARGIN_MS = 5_000;
/** Caps on what one action can put into the agent's context window. */
export const MAX_TEXT_CHARS = 20_000;
export const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_URL_LEN = 2048;
const MAX_SELECTOR_LEN = 500;
const MAX_FILL_LEN = 10_000;
const MIN_DIM = BROWSER_MIN_DIM;
const MAX_DIM = BROWSER_MAX_DIM;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

export const BROWSER_ACTIONS = [
  "goto",
  "snapshot",
  "text",
  "click",
  "fill",
  "press",
  "screenshot",
  "close",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export type BrowserErrorCode =
  | "invalid_request"
  | "no_browser"
  | "launch_failed"
  | "no_page"
  | "action_failed"
  | "action_timeout";

export interface BrowserFailure {
  ok: false;
  status: 400 | 500;
  code: BrowserErrorCode;
  error: string;
}

export interface BrowserSuccess {
  ok: true;
  /** The page's URL after the action. */
  url: string;
  /** The page's title after the action. */
  title: string;
  /** `snapshot` only: the ARIA tree, the same view a screen reader gets. */
  snapshot?: string;
  /** `text` only: the rendered text of the page body. */
  text?: string;
  /** `screenshot` only: PNG bytes for the caller to turn into a chat card. */
  png?: Buffer;
  /** `screenshot` only: attachment name, query string stripped. */
  filename?: string;
  /** `screenshot` only: caption for the card - origin + pathname. */
  caption?: string;
  /** True when the action closed the agent's context. */
  closed?: boolean;
  /** An agent goto created a fresh page; used for manager panel notification. */
  createdPage?: boolean;
}

export type BrowserResult = BrowserSuccess | BrowserFailure;

export interface BrowserSessionDeps {
  /** Resolve the browser executable. Default: preview-capture's probe. */
  findBrowser?: () => string | null;
  /** Launch a browser at that path. Default: playwright-core chromium. */
  launch?: (executablePath: string) => Promise<Browser>;
  /** Idle life of an agent's context. Default: BROWSER_IDLE_MS. */
  idleMs?: number;
  /**
   * Per-operation Playwright timeout. Default: BROWSER_ACTION_DEADLINE_MS.
   * Tests inject a short one to exercise the timeout path.
   */
  actionMs?: number;
  /**
   * The pool's own backstop, for a Playwright call that ignores its timeout.
   * Default: actionMs + BACKSTOP_MARGIN_MS. Tests inject a short one.
   */
  backstopMs?: number;
  /** Root for per-member browser profiles. Default: the active isomux root. */
  stateRoot?: string;
}

type JsonObject = Record<string, unknown>;
type BrowserStorageState = {
  cookies: JsonObject[];
  origins: JsonObject[];
  credentials?: JsonObject[];
};

const EMPTY_STORAGE_STATE: BrowserStorageState = { cookies: [], origins: [] };

function cloneState(state: BrowserStorageState): BrowserStorageState {
  return structuredClone(state);
}

function itemKey(item: JsonObject, fields: string[]): string {
  return fields
    .map((field) => (typeof item[field] === "string" ? item[field] : ""))
    .join("\0");
}

function originKey(origin: JsonObject): string {
  return typeof origin.origin === "string" ? origin.origin : "";
}

function mergeItems(
  latest: JsonObject[],
  baseline: JsonObject[],
  current: JsonObject[],
  fields: string[],
): JsonObject[] {
  const out = new Map(latest.map((item) => [itemKey(item, fields), item]));
  const before = new Map(baseline.map((item) => [itemKey(item, fields), item]));
  const after = new Map(current.map((item) => [itemKey(item, fields), item]));
  // Playwright emits these plain objects in a stable field order. Comparing
  // their JSON therefore detects a changed value without normalizing secrets.
  for (const [key, item] of after) {
    if (JSON.stringify(before.get(key)) !== JSON.stringify(item))
      out.set(key, item);
  }
  for (const [key, item] of before) {
    if (
      !after.has(key) &&
      JSON.stringify(out.get(key)) === JSON.stringify(item)
    ) {
      out.delete(key);
    }
  }
  return [...out.values()];
}

/** Merge only this context's changes into the newest per-member state. */
export function mergeBrowserStorageState(
  latest: BrowserStorageState,
  baseline: BrowserStorageState,
  current: BrowserStorageState,
): BrowserStorageState {
  const origins = new Map(
    latest.origins.map((origin) => [
      originKey(origin),
      cloneState({ cookies: [], origins: [origin] }).origins[0],
    ]),
  );
  const beforeOrigins = new Map(
    baseline.origins.map((origin) => [originKey(origin), origin]),
  );
  for (const currentOrigin of current.origins) {
    const origin = originKey(currentOrigin);
    const latestOrigin = origins.get(origin) ?? { origin };
    const beforeOrigin = beforeOrigins.get(origin) ?? { origin };
    origins.set(origin, {
      ...latestOrigin,
      ...currentOrigin,
      localStorage: mergeItems(
        (latestOrigin.localStorage as JsonObject[] | undefined) ?? [],
        (beforeOrigin.localStorage as JsonObject[] | undefined) ?? [],
        (currentOrigin.localStorage as JsonObject[] | undefined) ?? [],
        ["name"],
      ),
      indexedDB: mergeItems(
        (latestOrigin.indexedDB as JsonObject[] | undefined) ?? [],
        (beforeOrigin.indexedDB as JsonObject[] | undefined) ?? [],
        (currentOrigin.indexedDB as JsonObject[] | undefined) ?? [],
        ["name"],
      ),
    });
  }
  return {
    cookies: mergeItems(latest.cookies, baseline.cookies, current.cookies, [
      "name",
      "domain",
      "path",
    ]),
    origins: [...origins.values()],
    credentials: mergeItems(
      latest.credentials ?? [],
      baseline.credentials ?? [],
      current.credentials ?? [],
      ["id"],
    ),
  };
}

function fail(
  status: 400 | 500,
  code: BrowserErrorCode,
  error: string,
): BrowserFailure {
  return { ok: false, status, code, error };
}

function invalid(error: string): BrowserFailure {
  return fail(400, "invalid_request", error);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Chrome flags. The phone-home suppression matches preview-capture.ts, which
// found them by observation on this box: without them a fresh profile runs the
// component updater and the optimization-guide downloads on every launch.
// Playwright supplies --password-store=basic and --use-mock-keychain itself.
const LAUNCH_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-client-side-phishing-detection",
  "--disable-domain-reliability",
  "--metrics-recording-only",
  "--disable-features=OptimizationHints,MediaRouter,Translate",
];

/**
 * Exported so a test can pin the signal flags without launching Chrome.
 *
 * Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers by default and
 * does NOT re-raise. `server/backends/opencode/supervisor.ts` re-raises SIGTERM
 * after its own cleanup, Playwright's handler swallowed that, and an office
 * that had ever opened a browser stopped answering SIGTERM at all:
 * `systemctl stop isomux` would wait out its timeout and then SIGKILL.
 * Measured on this box 2026-09-05 - an isolated office with the browser
 * untouched exited in 2 s on SIGTERM, one that had used the browser was still
 * alive minutes later. Turning the three options off is the whole fix.
 */
export function launchOptions(executablePath: string) {
  return {
    executablePath,
    headless: true as const,
    args: LAUNCH_ARGS,
    // NO signal handlers of Playwright's own. This module deliberately
    // installs none either: `server/backends/opencode/supervisor.ts` already
    // owns SIGINT and SIGTERM for this process, and two independent
    // self-re-raising reapers cannot compose - both run, and whichever
    // finishes first re-raises and kills the process in the middle of the
    // other's cleanup. Measured with both modules imported: listenerCount was
    // 2 for each signal.
    //
    // Nothing here needs a handler. Chrome is a child on a remote-debugging
    // pipe, so it exits when this process does. See section 11.3 of
    // internal-docs/browser-use-exploration.md for the measurement.
    handleSIGINT: false as const,
    handleSIGTERM: false as const,
    handleSIGHUP: false as const,
  };
}

async function defaultLaunch(executablePath: string): Promise<Browser> {
  // Imported here, not at module load: playwright-core pulls in a large
  // dependency tree, and an office where no agent opens a browser should not
  // pay for it at boot.
  const { chromium } = await import("playwright-core");
  return chromium.launch(launchOptions(executablePath));
}

interface AgentSession {
  profileId: string | null;
  baselineState: BrowserStorageState;
  context: BrowserContext;
  /** The page the agent acts on. A window the site opens replaces it. */
  page: Page;
  /**
   * True once a goto has landed, or once the site opened a window. The actions
   * that need a page check this BEFORE calling Playwright: on a fresh context
   * a click would otherwise wait for a selector on about:blank and come back
   * as a timeout instead of the documented no_page.
   */
  opened: boolean;
  title: string;
  heldByManager: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  screencast: CDPSession | null;
  screencastStarting: Promise<void> | null;
  captureSize: string | null;
  lastFrame: BrowserFrame | null;
}

export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
}

export type BrowserFrameListener = (frame: BrowserFrame | null) => void;

// One browser, one context per agent. Module-level because the browser is an
// office-wide resource; the class stays exported so a test can hold its own.
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, AgentSession>();
  // One promise chain per agent. See serialize().
  private readonly queues = new Map<string, Promise<unknown>>();
  // ONE chain for the whole office. See lifecycle().
  private lifecycleChain: Promise<unknown> = Promise.resolve();
  private readonly findBrowser: () => string | null;
  private readonly launch: (executablePath: string) => Promise<Browser>;
  private readonly idleMs: number;
  private readonly actionMs: number;
  private readonly backstopMs: number;
  private readonly stateRoot: string;
  private readonly profileChains = new Map<string, Promise<unknown>>();
  private readonly viewerBounds = new Map<BrowserFrameListener, {maxWidth?:number;maxHeight?:number}>();
  private readonly managerViewers = new Map<BrowserFrameListener, () => boolean>();
  private readonly frameListeners = new Map<
    string,
    Set<BrowserFrameListener>
  >();

  constructor(deps: BrowserSessionDeps = {}) {
    this.findBrowser = deps.findBrowser ?? defaultFindBrowser;
    this.launch = deps.launch ?? defaultLaunch;
    this.idleMs = deps.idleMs ?? BROWSER_IDLE_MS;
    this.actionMs = deps.actionMs ?? BROWSER_ACTION_DEADLINE_MS;
    this.backstopMs = deps.backstopMs ?? this.actionMs + BACKSTOP_MARGIN_MS;
    this.stateRoot = deps.stateRoot ?? STATE_ROOT;
  }

  private profilePath(profileId: string): string {
    return join(
      this.stateRoot,
      "browser-profiles",
      encodeURIComponent(profileId),
      "storage-state.json",
    );
  }

  private readProfile(profileId: string): BrowserStorageState {
    const path = this.profilePath(profileId);
    if (!existsSync(path)) return cloneState(EMPTY_STORAGE_STATE);
    try {
      const value = JSON.parse(
        readFileSync(path, "utf8"),
      ) as BrowserStorageState;
      if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
        throw new Error("invalid shape");
      }
      return {
        cookies: value.cookies,
        origins: value.origins,
        credentials: Array.isArray(value.credentials) ? value.credentials : [],
      };
    } catch {
      let stamp = Date.now();
      while (existsSync(`${path}.corrupt-${stamp}`)) stamp++;
      try {
        renameSync(path, `${path}.corrupt-${stamp}`);
        console.error(`[browser] moved corrupt profile aside: ${path}`);
      } catch {
        // A concurrent remove or a read-only directory must not strand every
        // agent of this member. Start empty and try recovery again next time.
        console.error(
          `[browser] could not move corrupt profile aside: ${path}`,
        );
      }
      return cloneState(EMPTY_STORAGE_STATE);
    }
  }

  private serializeProfile<T>(
    profileId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prev = this.profileChains.get(profileId) ?? Promise.resolve();
    const result = prev.then(work, work);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.profileChains.set(profileId, tail);
    void tail.then(() => {
      if (this.profileChains.get(profileId) === tail)
        this.profileChains.delete(profileId);
    });
    return result;
  }

  private async saveProfile(
    profileId: string,
    baseline: BrowserStorageState,
    current: BrowserStorageState,
  ): Promise<void> {
    await this.serializeProfile(profileId, async () => {
      const path = this.profilePath(profileId);
      const next = mergeBrowserStorageState(
        this.readProfile(profileId),
        baseline,
        current,
      );
      const dir = dirname(path);
      mkdirSync(dir, {
        recursive: true,
        mode: 0o700,
      });
      chmodSync(dir, 0o700);
      atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n", 0o600);
    });
  }

  private async persistSessionProfile(session: AgentSession): Promise<void> {
    if (!session.profileId) return;
    const work = session.context.storageState({
      indexedDB: true,
      credentials: true,
    });
    let state: BrowserStorageState;
    try {
      state = await withDeadline(work, this.actionMs);
    } catch {
      // A crashed or wedged browser cannot provide state. Keep the last durable
      // profile rather than holding this agent's queue open.
      return;
    }
    await this.saveProfile(session.profileId, session.baselineState, state);
  }

  /**
   * Run one agent's work at a time. Everything that touches an agent's session
   * goes through here: actions, the close action, the idle timer, and the kill
   * path.
   *
   * Without it, two cold calls for one agent both miss the session lookup, both
   * create a context, and the second overwrites the first in the map. The first
   * context then belongs to nobody, is never closed, and survives shutdown.
   * Serializing also means a close can never land between ensureSession and the
   * action it was preparing.
   */
  private serialize<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    // Same handler both ways: a failed predecessor must not stop the queue.
    const result = prev.then(work, work);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.queues.set(agentId, tail);
    // Drop the entry once nothing is behind it, so a killed agent leaves none.
    void tail.then(() => {
      if (this.queues.get(agentId) === tail) this.queues.delete(agentId);
    });
    return result;
  }

  /**
   * Run one office-wide lifecycle step at a time: creating a context, and
   * closing the browser when the last context goes. Page actions stay
   * concurrent across agents - only the shared browser's existence is
   * serialized here.
   *
   * Per-agent queues are not enough, because the browser is shared. Without
   * this, agent A's close and agent B's first call interleave: A removes the
   * only session and blocks; B sees a connected browser and blocks in
   * newContext; A resumes, finds no sessions left, and closes the office
   * browser; B resumes and installs a session attached to a browser that is
   * gone.
   *
   * LOCK ORDER, and it must not be reversed: the agent queue first, this
   * second. Nothing here ever takes an agent queue.
   */
  private lifecycle<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(work, work);
    this.lifecycleChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Unlink the browser and hand it back for closing. Called only inside
   * lifecycle(): once it returns, nobody can attach to the browser, so the
   * slow close itself can run outside the lock and block no one.
   */
  private detachBrowser(): Browser | null {
    const browser = this.browser;
    this.browser = null;
    return browser;
  }

  /** Agent ids that currently hold a context. Exported for tests and metrics. */
  activeAgents(): string[] {
    return [...this.sessions.keys()];
  }

  watch(agentId: string, listener: BrowserFrameListener, isManager: () => boolean = () => true, bounds: {maxWidth?:number;maxHeight?:number} = {}): () => void {
    this.viewerBounds.set(listener, bounds);
    this.managerViewers.set(listener, isManager);
    let listeners = this.frameListeners.get(agentId);
    if (!listeners) {
      listeners = new Set();
      this.frameListeners.set(agentId, listeners);
    }
    listeners.add(listener);
    const session = this.sessions.get(agentId);
    listener(null);
    if (session) {
      if (session.lastFrame) listener(session.lastFrame);
      this.refreshPresence(agentId, session);
      void this.startScreencast(agentId, session);
    }
    return () => {
      const current = this.frameListeners.get(agentId);
      current?.delete(listener);
      this.managerViewers.delete(listener);
      this.viewerBounds.delete(listener);
      const active = this.sessions.get(agentId);
      if (active) this.refreshPresence(agentId, active);
      if (current?.size) {
        if (active) void this.startScreencast(agentId, active);
        return;
      }
      this.frameListeners.delete(agentId);
      // A reconnect can replace one watcher with another in the same turn.
      // Let that replacement attach before deciding that capture has no viewer.
      void Promise.resolve().then(() => {
        if (this.frameListeners.get(agentId)?.size) return;
        const session = this.sessions.get(agentId);
        if (!session) return;
        void this.stopScreencast(session);
        this.refreshPresence(agentId, session);
      });
    };
  }

  private async startScreencast(
    agentId: string,
    session: AgentSession,
  ): Promise<void> {
    if (!this.frameListeners.get(agentId)?.size) return;
    if (session.screencastStarting) {
      await session.screencastStarting;
      return this.startScreencast(agentId, session);
    }
    const bounds = this.captureBounds(agentId, session);
    const size = `${bounds.maxWidth}x${bounds.maxHeight}`;
    if (session.screencast && session.captureSize === size) return;
    const starting = (async () => {
      if (session.screencast) await this.stopScreencast(session);
      await this.startScreencastNow(agentId, session);
    })();
    session.screencastStarting = starting;
    try {
      await starting;
    } finally {
      if (session.screencastStarting === starting)
        session.screencastStarting = null;
    }
  }

  private captureBounds(agentId: string, session: AgentSession) {
    const viewport = session.page.viewportSize() ?? {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT};
    const viewers = [...(this.frameListeners.get(agentId) ?? [])].map(listener => this.viewerBounds.get(listener) ?? {});
    return {
      maxWidth: Math.min(viewport.width, Math.max(...viewers.map(bound => bound.maxWidth ?? viewport.width))),
      maxHeight: Math.min(viewport.height, Math.max(...viewers.map(bound => bound.maxHeight ?? viewport.height))),
    };
  }

  private async startScreencastNow(
    agentId: string,
    session: AgentSession,
  ): Promise<void> {
    try {
      const cdp = await session.context.newCDPSession(session.page);
      if (
        this.sessions.get(agentId) !== session ||
        session.page.isClosed() ||
        !this.frameListeners.get(agentId)?.size
      ) {
        await cdp.detach().catch(() => {});
        return;
      }
      session.screencast = cdp;
      cdp.on("Page.frameNavigated", () => { void this.updateStatus(agentId, session); });
      await cdp.send("Page.enable");
      await this.updateStatus(agentId, session);
      let receivedFrame = false;
      cdp.on(
        "Page.screencastFrame",
        (event: {
          data: string;
          sessionId: number;
          metadata?: { deviceWidth?: number; deviceHeight?: number };
        }) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => {});
          if (session.screencast !== cdp) return;
          receivedFrame = true;
          this.refreshPresence(agentId, session);
          const viewport = session.page.viewportSize() ?? {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
          };
          const frame = {
            data: event.data,
            width: event.metadata?.deviceWidth ?? viewport.width,
            height: event.metadata?.deviceHeight ?? viewport.height,
          };
          this.publishFrame(agentId, session, frame);
        },
      );
      if (session.screencast !== cdp || !this.frameListeners.get(agentId)?.size) return;
      const bounds = this.captureBounds(agentId, session);
      session.captureSize = `${bounds.maxWidth}x${bounds.maxHeight}`;
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 50,
        everyNthFrame: 2,
        ...bounds,
      });
      // A static tab can emit no initial frame with everyNthFrame > 1.
      // Seed the view once, but never replace a newer screencast frame.
      if (!receivedFrame) {
        const viewport = session.page.viewportSize() ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "jpeg", quality: 50,
          clip: { x: 0, y: 0, ...viewport, scale: Math.min(bounds.maxWidth / viewport.width, bounds.maxHeight / viewport.height) },
        }).catch(() => null);
        if (shot?.data && !receivedFrame && session.screencast === cdp && this.sessions.get(agentId) === session) {
          this.publishFrame(agentId, session, {data:shot.data,...viewport});
        }
      }
    } catch {
      if (session.screencast) await this.stopScreencast(session);
      for (const listener of this.frameListeners.get(agentId) ?? [])
        listener(null);
    }
  }

  private publishFrame(agentId: string, session: AgentSession, frame: BrowserFrame): void {
    session.lastFrame = frame;
    for (const listener of this.frameListeners.get(agentId) ?? []) listener(frame);
  }

  private async stopScreencast(session?: AgentSession): Promise<void> {
    const cdp = session?.screencast;
    if (!session || !cdp) return;
    session.screencast = null;
    session.captureSize = null;
    session.lastFrame = null;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }

  private notifyUnavailable(agentId: string): void {
    for (const listener of this.frameListeners.get(agentId) ?? [])
      listener(null);
  }

  async humanInput(
    agentId: string,
    input: Exclude<BrowserHumanInput, BrowserNavigation>,
  ): Promise<boolean> {
    const session = this.sessions.get(agentId);
    if (!session || !session.screencast || session.page.isClosed())
      return false;
    this.touch(agentId, session);
    const cdp = session.screencast;
    if (input.kind === "mouse") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: input.event,
        x: input.x,
        y: input.y,
        ...(input.button === undefined ? {} : { button: input.button }),
        ...(input.clickCount === undefined
          ? {}
          : { clickCount: input.clickCount }),
        ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
        ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
        ...(input.modifiers === undefined
          ? {}
          : { modifiers: input.modifiers }),
      });
    } else {
      await cdp.send("Input.dispatchKeyEvent", {
        type: input.event,
        key: input.key,
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.modifiers === undefined
          ? {}
          : { modifiers: input.modifiers }),
      });
    }
    return true;
  }

  private async ensureBrowser(): Promise<Browser | BrowserFailure> {
    if (this.browser?.isConnected()) return this.browser;
    // A browser that died (crash, kill) leaves stale sessions behind: their
    // contexts belong to a process that is gone.
    if (this.browser) this.dropAllSessions();
    if (!this.launching) {
      const executable = this.findBrowser();
      if (!executable) {
        return fail(
          500,
          "no_browser",
          `no Chrome-family browser found (tried ${BROWSER_CANDIDATES.join(", ")} ` +
            "and the standard install paths); install one or point " +
            "ISOMUX_PREVIEW_BROWSER at an executable",
        );
      }
      this.launching = this.launch(executable).finally(() => {
        this.launching = null;
      });
    }
    try {
      this.browser = await this.launching;
      return this.browser;
    } catch (err) {
      return fail(
        500,
        "launch_failed",
        `could not start the browser: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private dropAllSessions(): void {
    for (const [agentId, session] of this.sessions) {
      if (session.timer) clearTimeout(session.timer);
      void this.stopScreencast(session);
      this.sessions.delete(agentId);
      this.notifyUnavailable(agentId);
    }
    this.sessions.clear();
    this.browser = null;
  }

  private touch(agentId: string, session: AgentSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    // Only the manager can keep the profile context alive.
    session.heldByManager = this.hasManagerViewer(agentId);
    session.timer = setTimeout(() => {
      // Recheck even on a static page with no new capture frames.
      if (this.hasManagerViewer(agentId)) { this.touch(agentId, session); return; }
      void this.close(agentId).catch((err: unknown) => {
        console.error(
          `[browser] could not persist idle profile for ${agentId}:`,
          err,
        );
      });
    }, this.idleMs);
    // An idle timer must never hold the process open at shutdown.
    session.timer.unref?.();
  }

  private hasManagerViewer(agentId: string): boolean {
    return [...(this.frameListeners.get(agentId) ?? [])].some(listener => this.managerViewers.get(listener)?.());
  }

  private refreshPresence(agentId: string, session: AgentSession): void {
    if (this.hasManagerViewer(agentId) !== session.heldByManager) this.touch(agentId, session);
  }

  status(agentId: string): { available: boolean; url: string; title: string } {
    const session = this.sessions.get(agentId);
    if (!session || session.page.isClosed()) return { available: false, url: "", title: "" };
    return { available: true, url: session.page.url(), title: session.title };
  }

  private async updateStatus(agentId: string, session: AgentSession): Promise<void> {
    const page = session.page;
    const title = await page.title().catch(() => "");
    if (this.sessions.get(agentId) !== session || session.page !== page) return;
    session.title = title;
    for (const listener of this.frameListeners.get(agentId) ?? []) listener(null);
  }

  /** Navigation shares the agent queue; pointer and keyboard input remain immediate. */
  async humanNavigate(agentId: string, input: BrowserNavigation, profileId: string): Promise<BrowserResult> {
    if (input.action === "goto") return this.run(agentId, { action: "goto", url: input.url }, profileId);
    if (input.action === "close") return this.run(agentId, { action: "close" }, profileId);
    return this.serialize(agentId, async () => {
      if (input.action === "open") {
        const session = await this.ensureSession(agentId, profileId, {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT});
        if ("ok" in session) return session;
        await this.updateStatus(agentId, session);
        return { ok: true, url: session.page.url(), title: session.title };
      }
      const session = this.sessions.get(agentId);
      if (!session || session.page.isClosed()) return fail(400, "no_page", "no page is open");
      this.touch(agentId, session);
      let work: Promise<unknown> | undefined;
      try {
        const options = { timeout: this.actionMs, waitUntil: "load" as const };
        work = input.action === "back" ? session.page.goBack(options)
          : input.action === "forward" ? session.page.goForward(options) : session.page.reload(options);
        await withDeadline(work, this.backstopMs);
        session.opened = session.page.url() !== "about:blank";
        await this.updateStatus(agentId, session);
        return { ok: true, url: session.page.url(), title: session.title };
      } catch (error) {
        if (error instanceof DeadlineError) {
          await this.closeNow(agentId);
          if (work) await work.catch(() => {});
        }
        return fail(500, error instanceof DeadlineError ? "action_timeout" : "action_failed", error instanceof Error ? error.message.split("\n")[0] : String(error));
      }
    });
  }

  private async ensureSession(
    agentId: string,
    profileId: string | null,
    viewport: { width: number; height: number },
  ): Promise<AgentSession | BrowserFailure> {
    // Fast path, no office lock: this agent already has a live page on a live
    // browser, so it needs nothing from the shared lifecycle. Safe against a
    // concurrent close, because the browser is only closed when NO session is
    // left and this session is one.
    const live = this.sessions.get(agentId);
    if (live && !live.page.isClosed() && this.browser?.isConnected()) {
      this.touch(agentId, live);
      return live;
    }
    // Anything that creates a context, or that could relaunch the browser,
    // runs one at a time for the whole office.
    return this.lifecycle(() =>
      this.createSession(agentId, profileId, viewport),
    );
  }

  private async createSession(
    agentId: string,
    profileId: string | null,
    viewport: { width: number; height: number },
  ): Promise<AgentSession | BrowserFailure> {
    // The browser first, ALWAYS. A dead browser leaves sessions whose pages
    // still answer isClosed() with false, so a session lookup ahead of this
    // would hand back a context that belongs to a process that is gone.
    // ensureBrowser drops those sessions before it relaunches.
    const browser = await this.ensureBrowser();
    if ("ok" in browser) return browser;
    // Re-read after the await: another agent's lifecycle step may have run
    // while this one waited for the lock.
    const existing = this.sessions.get(agentId);
    if (existing && !existing.page.isClosed()) {
      this.touch(agentId, existing);
      return existing;
    }
    // A closed page with a live browser: drop the context, keep the browser -
    // we are about to make a new context in it.
    if (existing) await this.discard(agentId);
    const baselineState = profileId
      ? await this.serializeProfile(profileId, async () =>
          this.readProfile(profileId),
        )
      : cloneState(EMPTY_STORAGE_STATE);
    const context = await browser.newContext({
      viewport,
      acceptDownloads: false,
      storageState: baselineState as never,
    });
    const page = await context.newPage();
    const session: AgentSession = {
      profileId,
      baselineState,
      context,
      page,
      opened: false,
      title: "",
      heldByManager: false,
      timer: null,
      screencast: null,
      screencastStarting: null,
      captureSize: null,
      lastFrame: null,
    };
    this.sessions.set(agentId, session);
    // Registered AFTER the first page, so this agent's own page does not read
    // as a window the site opened. A window IS how a person following a
    // target=_blank link ends up somewhere new, so the agent goes with it - and
    // the page it left closes behind it. ONE page per agent is the invariant
    // the footprint measurement rests on (internal-docs/
    // browser-use-exploration.md section 8); a second live page would multiply
    // the per-context cost the shared-browser case is argued from.
    //
    // On the agent's own queue, so the swap can never land inside an action:
    // a click that opens a window completes on the page it clicked, and the
    // swap runs after it.
    context.on("page", (fresh: Page) => {
      void this.serialize(agentId, async () => {
        const current = this.sessions.get(agentId);
        if (!current || current.context !== context) return;
        if (fresh === current.page || fresh.isClosed()) return;
        const previous = current.page;
        await this.stopScreencast(current);
        current.page = fresh;
        current.opened = true;
        await previous.close().catch(() => {});
        await this.startScreencast(agentId, current);
      });
    });
    this.touch(agentId, session);
    void this.startScreencast(agentId, session);
    return session;
  }

  /** Drop one agent's context, leaving the browser alone. */
  private async discard(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    if (session.timer) clearTimeout(session.timer);
    await this.stopScreencast(session);
    this.notifyUnavailable(agentId);
    await this.persistSessionProfile(session);
    try {
      await session.context.close();
    } catch {
      // The context can already be gone with its browser. Nothing to repair.
    }
  }

  /**
   * Close one agent's context, and the browser with it when it was the last
   * one. Safe to call when the agent holds no context. Queued, so it cannot
   * land in the middle of an action.
   */
  async close(agentId: string): Promise<void> {
    await this.serialize(agentId, () => this.closeNow(agentId));
  }

  /** close() without the agent queue. Only call from inside queued work. */
  private async closeNow(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    // Under the office lock: drop the session and, if it was the last one,
    // unlink the browser. Both together, so no other agent can install a
    // session between the two and end up attached to a browser we then close.
    const orphan = await this.lifecycle(async () => {
      if (this.sessions.get(agentId) !== session) return null;
      this.sessions.delete(agentId);
      return this.sessions.size === 0 ? this.detachBrowser() : null;
    });
    // Teardown outside the lock: it is slow, and nothing can reach either of
    // these any more.
    await this.stopScreencast(session);
    this.notifyUnavailable(agentId);
    await this.persistSessionProfile(session);
    await session.context.close().catch(() => {});
    if (orphan) await orphan.close().catch(() => {});
  }

  /** Close the browser itself. Used at shutdown; the last close() does its own. */
  async closeBrowser(): Promise<void> {
    const orphan = await this.lifecycle(async () => this.detachBrowser());
    if (orphan) await orphan.close().catch(() => {});
  }

  /** Close every context and the browser. For shutdown and for tests. */
  async shutdown(): Promise<void> {
    for (const agentId of [...this.sessions.keys()]) await this.close(agentId);
    await this.closeBrowser();
  }

  async run(
    agentId: string,
    body: unknown,
    profileId: string | null = null,
  ): Promise<BrowserResult> {
    // Validation is pure and cheap, so it runs before the queue: a malformed
    // body must not wait behind another action to be told it is malformed.
    const parsed = parseBrowserParams(body);
    if (!parsed.ok) return parsed;
    const params = parsed;
    return this.serialize(agentId, () =>
      this.runNow(agentId, profileId, params),
    );
  }

  private async runNow(
    agentId: string,
    profileId: string | null,
    params: ParsedParams,
  ): Promise<BrowserResult> {
    if (params.action === "close") {
      await this.closeNow(agentId);
      return { ok: true, url: "", title: "", closed: true };
    }

    const createdPage = params.action === "goto" && !this.status(agentId).available;
    const session = await this.ensureSession(
      agentId,
      profileId,
      params.viewport,
    );
    if ("ok" in session) return session;

    // Before Playwright, not after. On a fresh context these actions would
    // otherwise wait out the selector timeout on about:blank and report
    // action_timeout instead of the documented no_page. goto is the action
    // that OPENS the page, so it is the one exemption (close never gets here).
    if (params.action !== "goto" && !session.opened) {
      return fail(
        400,
        "no_page",
        "no page is open; call the goto action first",
      );
    }

    let work: Promise<BrowserSuccess> | undefined;
    try {
      work = this.perform(session, params);
      const result = await withDeadline(work, this.backstopMs);
      await this.updateStatus(agentId, session);
      return createdPage ? { ...result, createdPage: true } : result;
    } catch (err) {
      if (err instanceof DeadlineError) {
        // Playwright's own timeout should have fired first. If we are here it
        // did not, so the losing operation is still running and can still
        // change the page. Drop the context so it has nothing left to change,
        // then WAIT for it before this queue slot releases - otherwise the next
        // action could overlap it. closeNow, not discard: if this was the last
        // context the office browser goes with it, rather than idling at its
        // fixed 350 MB with nothing attached.
        await this.closeNow(agentId);
        if (work) await work.catch(() => {});
        return fail(
          500,
          "action_timeout",
          `the browser did not finish ${params.action} in ${this.backstopMs}ms`,
        );
      }
      if (err instanceof NoPageError) {
        return fail(400, "no_page", err.message);
      }
      // Playwright's own errors are the useful ones here: "no element matches
      // selector", "net::ERR_CONNECTION_REFUSED". Pass the message through.
      return fail(
        500,
        "action_failed",
        err instanceof Error ? err.message.split("\n")[0] : String(err),
      );
    }
  }

  private async perform(
    session: AgentSession,
    params: ParsedParams,
  ): Promise<BrowserSuccess> {
    // Every Playwright call carries its own timeout, so the operation aborts
    // itself rather than being abandoned by a racing deadline. The pool's
    // backstop above only covers a Playwright that does not return at all.
    const timeout = this.actionMs;
    // Read the page fresh at each step: a window the site opens replaces it.
    switch (params.action) {
      case "goto":
        await session.page.goto(params.url!.toString(), {
          waitUntil: "load",
          timeout,
        });
        session.opened = true;
        break;
      case "click":
        await session.page.click(params.selector!, { timeout });
        break;
      case "fill":
        await session.page.fill(params.selector!, params.text!, { timeout });
        break;
      case "press":
        if (params.selector)
          await session.page.press(params.selector, params.key!, { timeout });
        else await session.page.keyboard.press(params.key!);
        break;
      case "snapshot":
      case "text":
      case "screenshot":
        break;
    }

    const page = session.page;
    // A page that navigated itself back to about:blank has nothing to read.
    // A blocked navigation (Chrome refuses a redirect to file://, for example)
    // lands on chrome-error://chromewebdata/ instead, which is a real page and
    // reads as an error page rather than as no_page.
    if (page.url() === "about:blank") throw new NoPageError();

    const base: BrowserSuccess = {
      ok: true,
      url: page.url(),
      title: await page.title(),
    };

    if (params.action === "snapshot") {
      base.snapshot = cap(
        await page.locator("body").ariaSnapshot({ timeout }),
        MAX_SNAPSHOT_CHARS,
      );
    } else if (params.action === "text") {
      base.text = cap(
        await page.innerText("body", { timeout }),
        MAX_TEXT_CHARS,
      );
    } else if (params.action === "screenshot") {
      base.png = await page.screenshot({
        fullPage: params.fullPage === true,
        timeout,
      });
      const shot = describeShot(page.url());
      base.filename = shot.filename;
      base.caption = shot.caption;
    }
    return base;
  }
}

class NoPageError extends Error {
  constructor() {
    super("no page is open; call the goto action first");
  }
}

class DeadlineError extends Error {}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cap(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n[truncated at ${max} characters]`;
}

// Card provenance, matching preview-capture: origin + pathname, never the query
// string, which can carry a token an agent pasted into a URL.
export function describeShot(raw: string): { filename: string; caption: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { filename: "page.png", caption: "" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return {filename:"page.png",caption:""};
  const path = url.pathname === "/" ? "" : url.pathname;
  const slug =
    `${url.host}${path}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) ||
    "page";
  return { filename: `${slug}.png`, caption: `${url.origin}${path}` };
}

interface ParsedParams {
  ok: true;
  action: BrowserAction;
  url?: URL;
  selector?: string;
  text?: string;
  key?: string;
  fullPage?: boolean;
  viewport: { width: number; height: number };
}

export function validBrowserBound(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_DIM && value <= MAX_DIM;
}

export function parseBrowserParams(
  body: unknown,
): ParsedParams | BrowserFailure {
  if (!isPlainObject(body)) return invalid("body must be a JSON object");
  const action = body.action;
  if (typeof action !== "string" || !isAction(action)) {
    return invalid(`action must be one of: ${BROWSER_ACTIONS.join(", ")}`);
  }

  const params: ParsedParams = {
    ok: true,
    action,
    viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
  };

  if (body.viewport !== undefined) {
    if (!isPlainObject(body.viewport))
      return invalid("viewport must be an object {width, height}");
    const { width: w, height: h } = body.viewport;
    if (!validBrowserBound(w) || !validBrowserBound(h)) {
      return invalid(
        `viewport width/height must be integers in ${MIN_DIM}..${MAX_DIM}`,
      );
    }
    params.viewport = { width: w, height: h };
  }

  if (action === "goto") {
    const raw = body.url;
    if (typeof raw !== "string" || raw.length === 0)
      return invalid("url is required for the goto action");
    if (raw.length > MAX_URL_LEN)
      return invalid(`url too long (max ${MAX_URL_LEN} chars)`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid(`not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return invalid("only http:// and https:// URLs are supported");
    if (url.username || url.password)
      return invalid("URLs with embedded credentials are not allowed");
    params.url = url;
  }

  if (action === "click" || action === "fill") {
    const selector = body.selector;
    if (typeof selector !== "string" || selector.length === 0)
      return invalid(`selector is required for the ${action} action`);
    if (selector.length > MAX_SELECTOR_LEN)
      return invalid(`selector too long (max ${MAX_SELECTOR_LEN} chars)`);
    params.selector = selector;
  }

  if (action === "fill") {
    const text = body.text;
    if (typeof text !== "string")
      return invalid("text is required for the fill action");
    if (text.length > MAX_FILL_LEN)
      return invalid(`text too long (max ${MAX_FILL_LEN} chars)`);
    params.text = text;
  }

  if (action === "press") {
    const key = body.key;
    if (typeof key !== "string" || key.length === 0)
      return invalid("key is required for the press action");
    if (key.length > MAX_SELECTOR_LEN)
      return invalid(`key too long (max ${MAX_SELECTOR_LEN} chars)`);
    params.key = key;
    const selector = body.selector;
    if (selector !== undefined) {
      if (typeof selector !== "string" || selector.length === 0)
        return invalid("selector must be a non-empty string");
      if (selector.length > MAX_SELECTOR_LEN)
        return invalid(`selector too long (max ${MAX_SELECTOR_LEN} chars)`);
      params.selector = selector;
    }
  }

  if (action === "screenshot" && body.fullPage !== undefined) {
    if (typeof body.fullPage !== "boolean")
      return invalid("fullPage must be a boolean");
    params.fullPage = body.fullPage;
  }

  return params;
}

function isAction(value: string): value is BrowserAction {
  return (BROWSER_ACTIONS as readonly string[]).includes(value);
}

/** The office-wide pool. One browser, one context per agent. */
export const browserPool = new BrowserPool();
