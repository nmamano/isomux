// Agent browser-session unit tests (task 9b174a6a) - the BrowserPool seam with
// an injected browser. The "browser" is a stub that records what Playwright
// would have been asked to do, so the real pool logic (launch once, one context
// per agent, idle close, close-the-browser-with-the-last-context, relaunch after
// a disconnect) runs without Chrome. Zero LLM, no network.
//
// What this freezes:
//   - strict validation before any browser work: an unknown action, a missing
//     required field, a non-http URL, credentials in the URL, and an
//     out-of-range viewport are all 400 invalid_request.
//   - one browser for the office and one context per agent, so two agents
//     cannot see each other's page.
//   - the browser is launched once and closed when the last context goes.
//   - an action on a context with no page open is 400 no_page, not a crash.
//   - the screenshot caption and filename drop the query string, matching
//     preview-capture, so a token pasted into a URL never reaches the card.
//   - the text and snapshot caps hold, so one action cannot fill an agent's
//     context window.

import { describe, it, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BrowserPool,
  parseBrowserParams,
  MAX_TEXT_CHARS,
  MAX_SNAPSHOT_CHARS,
  launchOptions,
  type BrowserResult,
} from "../browser-session.ts";
import { isBackendCredentialPath } from "../backend-credential-paths.ts";

// --- stub browser -----------------------------------------------------------

interface StubCalls {
  launches: number;
  contexts: number;
  closedContexts: number;
  browserClosed: number;
  actions: string[];
  storageStateOptions: Record<string, unknown>[];
  cdp: Array<{ method: string; params?: Record<string, unknown> }>;
}

interface StubOptions {
  /** Held until resolved, so a test can park newContext and race two callers. */
  contextGate?: Promise<void>;
  /** Held until resolved, so a test can prove profile capture is bounded. */
  storageStateGate?: Promise<void>;
  screenshot?: () => Promise<{ data: string }>;
  send?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

function stubBrowser(
  calls: StubCalls,
  page: Record<string, unknown> = {},
  options: StubOptions = {},
) {
  const overrides = page;
  const defaults = {
    url: () => "https://example.test/a?token=secret",
    title: async () => "Example",
    goto: async (u: string) => {
      calls.actions.push(`goto:${u}`);
    },
    click: async (s: string) => {
      calls.actions.push(`click:${s}`);
    },
    fill: async (s: string, t: string) => {
      calls.actions.push(`fill:${s}:${t}`);
    },
    press: async (s: string, k: string) => {
      calls.actions.push(`press:${s}:${k}`);
    },
    keyboard: {
      press: async (k: string) => {
        calls.actions.push(`key:${k}`);
      },
    },
    innerText: async () => "body text",
    locator: () => ({ ariaSnapshot: async () => '- heading "hi"' }),
    screenshot: async () => Buffer.from("PNG"),
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  // Each page carries its OWN closed flag. A single shared page object cannot
  // show "the old page closed" when a window replaces it.
  function makePage(): Record<string, unknown> {
    let closed = false;
    return {
      ...defaults,
      ...overrides,
      isClosed: () => closed,
      close: async () => {
        closed = true;
      },
    };
  }

  const contexts: Array<{
    browserId: number;
    pages: Array<Record<string, unknown>>;
    loadedState: Record<string, unknown>;
    setState: (state: Record<string, unknown>) => void;
    emitPage: (p: Record<string, unknown>) => void;
  }> = [];
  const cdpSessions: Array<{
    emit: (event: string, value: never) => void;
  }> = [];
  const instances: Array<{ id: number; isConnected: () => boolean }> = [];

  // A fresh browser per launch, the way Playwright behaves. Reusing one object
  // and flipping a flag makes a relaunch look like a dead browser.
  function makeBrowser() {
    let connected = true;
    const id = instances.length;
    const browser = {
      id,
      isConnected: () => connected,
      newContext: async (contextOptions: Record<string, unknown> = {}) => {
        calls.contexts++;
        if (options.contextGate) await options.contextGate;
        const listeners: Array<(p: unknown) => void> = [];
        const pages: Array<Record<string, unknown>> = [];
        const loadedState = structuredClone(
          (contextOptions.storageState as Record<string, unknown>) ?? {
            cookies: [],
            origins: [],
          },
        );
        let currentState = structuredClone(loadedState);
        const ctx = {
          browserId: id,
          newPage: async () => {
            const fresh = makePage();
            pages.push(fresh);
            return fresh;
          },
          on: (event: string, fn: (p: unknown) => void) => {
            if (event === "page") listeners.push(fn);
          },
          pages: () => pages,
          storageState: async (storageOptions: Record<string, unknown>) => {
            calls.storageStateOptions.push(storageOptions);
            if (options.storageStateGate) await options.storageStateGate;
            return structuredClone(currentState);
          },
          close: async () => {
            calls.closedContexts++;
          },
          newCDPSession: async () => {
            const listeners = new Map<string, (event: never) => void>();
            const cdp = {
              on: (event: string, fn: (event: never) => void) =>
                listeners.set(event, fn),
              send: async (
                method: string,
                params?: Record<string, unknown>,
              ) => {
                calls.cdp.push({ method, params });
                if (options.send) return options.send(method, params);
                if (method === "Page.getFrameTree")
                  return { frameTree: { frame: { id: "root" } } };
                if (method === "Page.createIsolatedWorld")
                  return { executionContextId: 1 };
                if (method === "Page.captureScreenshot")
                  return options.screenshot?.();
              },
              detach: async () => {},
              emit: (event: string, value: never) =>
                listeners.get(event)?.(value),
            };
            cdpSessions.push(cdp);
            return cdp;
          },
        };
        contexts.push({
          browserId: id,
          pages,
          loadedState,
          setState: (state) => {
            currentState = structuredClone(state);
          },
          emitPage: (fresh) => {
            pages.push(fresh);
            for (const fn of listeners) fn(fresh);
          },
        });
        return ctx;
      },
      close: async () => {
        calls.browserClosed++;
        connected = false;
      },
    };
    instances.push(browser);
    return browser;
  }

  return {
    contexts,
    cdpSessions,
    instances,
    makeBrowser,
    /** Arm the newContext gate after setup, so a race can be staged mid-test. */
    setGates: (newContextGate?: Promise<void>) => {
      options.contextGate = newContextGate;
    },
    /** Kill the newest browser without counting it as a close. */
    disconnect: () => {
      const latest = instances[instances.length - 1] as {
        isConnected: () => boolean;
      };
      Object.defineProperty(latest, "isConnected", { value: () => false });
    },
  };
}

function poolWith(
  calls: StubCalls,
  page?: Record<string, unknown>,
  idleMs = 60_000,
  options: StubOptions = {},
  extraDeps: Record<string, unknown> = {},
) {
  const stub = stubBrowser(calls, page, options);
  const pool = new BrowserPool({
    findBrowser: () => "/fake/chrome",
    launch: async () => {
      calls.launches++;
      return stub.makeBrowser() as never;
    },
    idleMs,
    ...extraDeps,
  });
  return { pool, stub };
}

function freshCalls(): StubCalls {
  return {
    launches: 0,
    contexts: 0,
    closedContexts: 0,
    browserClosed: 0,
    actions: [],
    storageStateOptions: [],
    cdp: [],
  };
}

/** A page the pool has navigated, so the no-page guard is satisfied. */
async function opened(
  pool: BrowserPool,
  agentId: string,
): Promise<BrowserResult> {
  return pool.run(agentId, { action: "goto", url: "https://example.test/" });
}

function expectFail(r: BrowserResult, code: string, status = 400) {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.code).toBe(code as never);
  expect(r.status).toBe(status as never);
}

// --- validation -------------------------------------------------------------

describe("parseBrowserParams", () => {
  it("rejects a body that is not an object", () => {
    for (const body of ["x", 3, null, ["goto"]]) {
      const r = parseBrowserParams(body);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an unknown or missing action", () => {
    for (const body of [{}, { action: "evaluate" }, { action: 7 }]) {
      const r = parseBrowserParams(body);
      expect(r.ok).toBe(false);
    }
  });

  it("accepts every documented action with its required fields", () => {
    const bodies = [
      { action: "goto", url: "http://localhost:4000/" },
      { action: "snapshot" },
      { action: "text" },
      { action: "click", selector: "#go" },
      { action: "fill", selector: "#name", text: "nil" },
      { action: "press", key: "Enter" },
      { action: "press", key: "Enter", selector: "#name" },
      { action: "screenshot" },
      { action: "screenshot", fullPage: true },
      { action: "close" },
    ];
    for (const body of bodies) {
      expect(parseBrowserParams(body).ok).toBe(true);
    }
  });

  it("rejects a URL that is not http or https", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "about:blank",
      "chrome://version",
      "javascript:alert(1)",
    ]) {
      expect(parseBrowserParams({ action: "goto", url }).ok).toBe(false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    const r = parseBrowserParams({
      action: "goto",
      url: "https://user:pw@example.test/",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a URL that is not a URL, and one that is too long", () => {
    expect(parseBrowserParams({ action: "goto", url: "not a url" }).ok).toBe(
      false,
    );
    const long = `https://example.test/${"a".repeat(3000)}`;
    expect(parseBrowserParams({ action: "goto", url: long }).ok).toBe(false);
  });

  it("requires the field each action needs", () => {
    expect(parseBrowserParams({ action: "goto" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "click" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "fill", selector: "#a" }).ok).toBe(
      false,
    );
    expect(parseBrowserParams({ action: "fill", text: "x" }).ok).toBe(false);
    expect(parseBrowserParams({ action: "press" }).ok).toBe(false);
  });

  it("keeps the viewport range strict, with no clamping", () => {
    for (const viewport of [
      { width: 100, height: 800 },
      { width: 1280, height: 9000 },
      { width: 1280.5, height: 800 },
      { width: "1280", height: 800 },
      [1280, 800],
    ]) {
      expect(parseBrowserParams({ action: "snapshot", viewport }).ok).toBe(
        false,
      );
    }
    const ok = parseBrowserParams({
      action: "snapshot",
      viewport: { width: 320, height: 2560 },
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects a non-boolean fullPage", () => {
    expect(
      parseBrowserParams({ action: "screenshot", fullPage: "yes" }).ok,
    ).toBe(false);
  });
});

// --- the pool ---------------------------------------------------------------

describe("launchOptions", () => {
  it("keeps Playwright's signal handlers off, so the office answers SIGTERM", () => {
    // The regression this pins, measured 2026-09-05: Playwright installs
    // SIGINT/SIGTERM/SIGHUP handlers by default and does not re-raise, so it
    // swallowed the SIGTERM that the OpenCode supervisor's reaper re-raises
    // after its own cleanup. An office that had opened a browser then stopped
    // exiting at all and systemd had to SIGKILL it. Turning these off is the
    // whole fix; browser-session installs no signal handler of its own,
    // because two self-re-raising reapers cut each other's cleanup short.
    const opts = launchOptions("/usr/bin/google-chrome");
    expect(opts.handleSIGINT).toBe(false);
    expect(opts.handleSIGTERM).toBe(false);
    expect(opts.handleSIGHUP).toBe(false);
    expect(opts.headless).toBe(true);
    expect(opts.executablePath).toBe("/usr/bin/google-chrome");
  });

  it("installs no signal handler: the OpenCode supervisor is the single owner", async () => {
    // Two independent self-re-raising reapers do not compose - both run on the
    // first signal, and whichever finishes first kills the process in the
    // middle of the other's cleanup. Measured with both modules imported
    // before this was fixed, listenerCount was 2 for each signal.
    //
    // A child process, not a dynamic import here: this file already imports
    // browser-session at the top, so an import inside the test is a cache hit
    // that registers nothing and would pass even with a reaper present.
    const probe = `
      const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
      await import(${JSON.stringify(new URL("../browser-session.ts", import.meta.url).pathname)});
      const after = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
      console.log(JSON.stringify({ before, after }));
    `;
    const run = Bun.spawnSync(["bun", "-e", probe]);
    const out = run.stdout.toString().trim();
    expect(run.exitCode, `probe failed: ${run.stderr.toString()}`).toBe(0);
    expect(JSON.parse(out)).toEqual({ before: 0, after: 0 });
  }, 30_000);

  it("does NOT pass --no-sandbox: untrusted pages keep Chrome's sandbox", () => {
    expect(launchOptions("/usr/bin/google-chrome").args).not.toContain(
      "--no-sandbox",
    );
  });
});

describe("BrowserPool", () => {
  it("treats persisted browser profiles as credentials", () => {
    expect(
      isBackendCredentialPath(
        "/srv/isomux/browser-profiles/boss-1/storage-state.json",
      ),
    ).toBe(true);
    expect(
      isBackendCredentialPath(
        "/srv/isomux/browser-profiles/boss-1/storage-state.json.corrupt-1789000000000",
      ),
    ).toBe(true);
  });

  it("persists one boss profile across agents without a stale close deleting a login", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "isomux-browser-profile-"));
    try {
      const calls = freshCalls();
      const { pool, stub } = poolWith(
        calls,
        undefined,
        60_000,
        {},
        { stateRoot },
      );
      await pool.run(
        "a",
        { action: "goto", url: "https://example.test/" },
        "boss-1",
      );
      await pool.run(
        "b",
        { action: "goto", url: "https://example.test/" },
        "boss-1",
      );
      stub.contexts[0].setState({
        cookies: [
          {
            name: "session",
            value: "logged-in",
            domain: "example.test",
            path: "/",
          },
        ],
        origins: [],
      });
      await pool.close("a");
      stub.contexts[1].setState({
        cookies: [
          {
            name: "preference",
            value: "from-b",
            domain: "example.test",
            path: "/",
          },
        ],
        origins: [],
      });
      // B opened from the empty profile. Its later close must merge its own
      // changes into the newest file instead of replacing A's login.
      await pool.close("b");
      const stored = JSON.parse(
        readFileSync(
          join(stateRoot, "browser-profiles", "boss-1", "storage-state.json"),
          "utf8",
        ),
      );
      expect(stored.cookies).toHaveLength(2);
      expect(
        stored.cookies.map((cookie: { value: string }) => cookie.value),
      ).toEqual(["logged-in", "from-b"]);
      expect(
        statSync(join(stateRoot, "browser-profiles", "boss-1")).mode & 0o777,
      ).toBe(0o700);
      expect(
        statSync(
          join(stateRoot, "browser-profiles", "boss-1", "storage-state.json"),
        ).mode & 0o777,
      ).toBe(0o600);
      expect(calls.storageStateOptions).toEqual([
        { indexedDB: true, credentials: true },
        { indexedDB: true, credentials: true },
      ]);

      await pool.run(
        "c",
        { action: "goto", url: "https://example.test/" },
        "boss-1",
      );
      expect(stub.contexts[2].loadedState).toEqual(stored);
      await pool.close("c");

      await pool.run(
        "d",
        { action: "goto", url: "https://example.test/" },
        "boss-2",
      );
      expect(stub.contexts[3].loadedState).toEqual({
        cookies: [],
        origins: [],
      });
      await pool.shutdown();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("uses the encoded profile path as the one 0700 directory", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "isomux-browser-profile-"));
    try {
      const calls = freshCalls();
      const { pool } = poolWith(calls, undefined, 60_000, {}, { stateRoot });
      await pool.run(
        "a",
        { action: "goto", url: "https://example.test/" },
        "boss one",
      );
      await pool.close("a");
      const encoded = join(stateRoot, "browser-profiles", "boss%20one");
      expect(existsSync(join(stateRoot, "browser-profiles", "boss one"))).toBe(
        false,
      );
      expect(statSync(encoded).mode & 0o777).toBe(0o700);
      expect(statSync(join(encoded, "storage-state.json")).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("moves a corrupt profile aside and starts from empty state", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "isomux-browser-profile-"));
    try {
      const dir = join(stateRoot, "browser-profiles", "boss-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "storage-state.json"), "{", { mode: 0o600 });
      const calls = freshCalls();
      const { pool, stub } = poolWith(
        calls,
        undefined,
        60_000,
        {},
        { stateRoot },
      );
      await pool.run(
        "a",
        { action: "goto", url: "https://example.test/" },
        "boss-1",
      );
      expect(stub.contexts[0].loadedState).toEqual({
        cookies: [],
        origins: [],
      });
      expect(
        readdirSync(dir).some((name) =>
          name.startsWith("storage-state.json.corrupt-"),
        ),
      ).toBe(true);
      await pool.close("a");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not hold the agent queue when profile capture is wedged", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "isomux-browser-profile-"));
    try {
      const calls = freshCalls();
      const { pool } = poolWith(
        calls,
        undefined,
        60_000,
        { storageStateGate: new Promise<void>(() => {}) },
        { stateRoot, actionMs: 10 },
      );
      await pool.run(
        "a",
        { action: "goto", url: "https://example.test/" },
        "boss-1",
      );
      const started = Date.now();
      await pool.close("a");
      expect(Date.now() - started).toBeLessThan(200);
      expect(pool.activeAgents()).toEqual([]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("launches one browser and gives each agent its own context", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    await pool.run("a", { action: "text" });
    await pool.run("b", { action: "goto", url: "https://example.test/" });
    expect(calls.launches).toBe(1);
    expect(calls.contexts).toBe(2);
    expect(pool.activeAgents().sort()).toEqual(["a", "b"]);
    await pool.shutdown();
  });

  it("closes the browser when the last context goes", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    await pool.run("b", { action: "goto", url: "https://example.test/" });
    await pool.close("a");
    expect(calls.closedContexts).toBe(1);
    expect(calls.browserClosed).toBe(0);
    await pool.close("b");
    expect(calls.closedContexts).toBe(2);
    expect(calls.browserClosed).toBe(1);
    expect(pool.activeAgents()).toEqual([]);
  });

  it("closes an idle context on its own", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, undefined, 20);
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    expect(pool.activeAgents()).toEqual(["a"]);
    await Bun.sleep(80);
    expect(pool.activeAgents()).toEqual([]);
    expect(calls.closedContexts).toBe(1);
  });

  it("the close action closes the caller's context and nobody else's", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    await pool.run("b", { action: "goto", url: "https://example.test/" });
    const r = await pool.run("a", { action: "close" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closed).toBe(true);
    expect(pool.activeAgents()).toEqual(["b"]);
    await pool.shutdown();
  });

  it("relaunches after the browser disconnects, and drops the stale context", async () => {
    const calls = freshCalls();
    const { pool, stub } = poolWith(calls);
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    stub.disconnect();
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    expect(calls.launches).toBe(2);
    expect(calls.contexts).toBe(2);
    await pool.shutdown();
  });

  it("reports no_browser when none is installed", async () => {
    const pool = new BrowserPool({ findBrowser: () => null });
    const r = await pool.run("a", {
      action: "goto",
      url: "https://example.test/",
    });
    expectFail(r, "no_browser", 500);
    if (!r.ok) expect(r.error).toContain("ISOMUX_PREVIEW_BROWSER");
  });

  it("reports launch_failed when the browser will not start", async () => {
    const pool = new BrowserPool({
      findBrowser: () => "/fake/chrome",
      launch: async () => {
        throw new Error("no display");
      },
    });
    const r = await pool.run("a", {
      action: "goto",
      url: "https://example.test/",
    });
    expectFail(r, "launch_failed", 500);
  });

  it("maps a Playwright failure to action_failed with its first line", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, {
      click: async () => {
        throw new Error("no element matches #missing\n  at page.click");
      },
    });
    await pool.run("a", { action: "goto", url: "https://example.test/" });
    const r = await pool.run("a", { action: "click", selector: "#missing" });
    expectFail(r, "action_failed", 500);
    if (!r.ok) expect(r.error).toBe("no element matches #missing");
    await pool.shutdown();
  });

  it("answers no_page when nothing has been opened yet", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    const r = await pool.run("a", { action: "snapshot" });
    expectFail(r, "no_page", 400);
    await pool.shutdown();
  });

  it("answers no_page BEFORE calling Playwright, so it cannot come back as a timeout", async () => {
    // The bug this pins: on a fresh context a click used to reach Playwright,
    // wait out the selector timeout on about:blank, and report action_timeout
    // instead of the documented 400.
    const calls = freshCalls();
    let clicked = false;
    const { pool } = poolWith(calls, {
      click: async () => {
        clicked = true;
      },
    });
    const r = await pool.run("a", { action: "click", selector: "#go" });
    expectFail(r, "no_page", 400);
    expect(clicked).toBe(false);
    await pool.shutdown();
  });

  it("treats a page that went back to about:blank as no page", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, { url: () => "about:blank" });
    // goto marks the session open; the page then reads as about:blank.
    await opened(pool, "a");
    const r = await pool.run("a", { action: "snapshot" });
    expectFail(r, "no_page", 400);
    await pool.shutdown();
  });

  it("returns the url and title after every action", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await opened(pool, "a");
    const r = await pool.run("a", {
      action: "click",
      selector: "#go",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe("https://example.test/a?token=secret");
    expect(r.title).toBe("Example");
    expect(calls.actions).toContain("click:#go");
    await pool.shutdown();
  });

  it("returns the ARIA snapshot and the body text on their own actions", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await opened(pool, "a");
    const snap = await pool.run("a", { action: "snapshot" });
    expect(snap.ok && snap.snapshot).toBe('- heading "hi"');
    expect(snap.ok && snap.text).toBeUndefined();
    const text = await pool.run("a", { action: "text" });
    expect(text.ok && text.text).toBe("body text");
    expect(text.ok && text.snapshot).toBeUndefined();
    await pool.shutdown();
  });

  it("caps the text and the snapshot so one action cannot fill a context window", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, {
      innerText: async () => "x".repeat(MAX_TEXT_CHARS + 5000),
      locator: () => ({
        ariaSnapshot: async () => "y".repeat(MAX_SNAPSHOT_CHARS + 5000),
      }),
    });
    await opened(pool, "a");
    const text = await pool.run("a", { action: "text" });
    expect(text.ok && text.text!.length).toBeLessThan(MAX_TEXT_CHARS + 100);
    expect(text.ok && text.text).toContain("[truncated at");
    const snap = await pool.run("a", { action: "snapshot" });
    expect(snap.ok && snap.snapshot).toContain("[truncated at");
    await pool.shutdown();
  });

  it("strips the query string from the screenshot caption and filename", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await opened(pool, "a");
    const r = await pool.run("a", { action: "screenshot" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.png).toBeInstanceOf(Buffer);
    expect(r.caption).toBe("https://example.test/a");
    expect(r.filename).not.toContain("secret");
    expect(r.filename).toEndWith(".png");
    await pool.shutdown();
  });

  it("presses a key with a selector and without one", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await opened(pool, "a");
    await pool.run("a", { action: "press", key: "Enter" });
    await pool.run("a", { action: "press", key: "Tab", selector: "#name" });
    expect(calls.actions).toContain("key:Enter");
    expect(calls.actions).toContain("press:#name:Tab");
    await pool.shutdown();
  });

  it("two cold calls for one agent make ONE context, and shutdown closes it", async () => {
    // The leak this pins: without the per-agent queue both callers pass the
    // session lookup, both create a context, and the second overwrites the
    // first in the map. The first context then belongs to nobody and survives
    // shutdown.
    const calls = freshCalls();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { pool } = poolWith(calls, undefined, 60_000, { contextGate: gate });
    const first = opened(pool, "a");
    const second = opened(pool, "a");
    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls.contexts).toBe(1);
    expect(pool.activeAgents()).toEqual(["a"]);
    await pool.shutdown();
    expect(calls.closedContexts).toBe(1);
    expect(calls.browserClosed).toBe(1);
  });

  it("a close racing an action runs after it, never inside it", async () => {
    const calls = freshCalls();
    const order: string[] = [];
    const { pool } = poolWith(calls, {
      click: async () => {
        await Bun.sleep(30);
        order.push("action");
      },
    });
    await opened(pool, "a");
    const action = pool.run("a", { action: "click", selector: "#go" });
    const closing = pool.close("a").then(() => order.push("close"));
    const r = await action;
    await closing;
    expect(r.ok).toBe(true);
    expect(order).toEqual(["action", "close"]);
    expect(pool.activeAgents()).toEqual([]);
  });

  it("a timed-out operation is drained before the next action runs", async () => {
    // The bug this pins: Promise.race returned action_timeout while the losing
    // Playwright call kept running, so it could land in the middle of the NEXT
    // action and change what that action saw.
    const calls = freshCalls();
    const order: string[] = [];
    const { pool } = poolWith(
      calls,
      {
        click: async () => {
          await Bun.sleep(60);
          order.push("late-click");
        },
        innerText: async () => {
          order.push("next-action");
          return "body text";
        },
      },
      60_000,
      {},
      { actionMs: 10, backstopMs: 20 },
    );
    await opened(pool, "a");
    const timedOut = await pool.run("a", { action: "click", selector: "#go" });
    expectFail(timedOut, "action_timeout", 500);
    // The context is gone, so the losing call has nothing left to change...
    expect(pool.activeAgents()).toEqual([]);
    // ...and it had already settled when the caller got its answer.
    expect(order).toEqual(["late-click"]);
    const next = await opened(pool, "a");
    expect(next.ok).toBe(true);
    await pool.run("a", { action: "text" });
    expect(order).toEqual(["late-click", "next-action"]);
    await pool.shutdown();
  });

  it("a window the site opens becomes the agent's page, and the old one closes", async () => {
    // ONE page per agent is the invariant the footprint measurement rests on.
    // A second live page would multiply the per-context cost the shared-browser
    // case is argued from, so adopting a window must close the page it left.
    const calls = freshCalls();
    const { pool, stub } = poolWith(calls);
    await opened(pool, "a");
    let popupClosed = false;
    const popup = {
      url: () => "https://popup.test/login",
      title: async () => "Popup",
      isClosed: () => popupClosed,
      close: async () => {
        popupClosed = true;
      },
      innerText: async () => "popup text",
    };
    const ctx = stub.contexts[0];
    const firstPage = ctx.pages[0] as { isClosed: () => boolean };
    ctx.emitPage(popup);
    // The swap runs on the agent's queue, so wait for that queue to drain.
    const r = await pool.run("a", { action: "text" });
    expect(r.ok && r.url).toBe("https://popup.test/login");
    expect(r.ok && r.text).toBe("popup text");
    expect(firstPage.isClosed()).toBe(true);
    expect(
      ctx.pages.filter((page) => !(page.isClosed as () => boolean)()).length,
    ).toBe(1);
    await pool.shutdown();
  });

  it("adopting a window happens after the action in flight, never inside it", async () => {
    const calls = freshCalls();
    const order: string[] = [];
    const { pool, stub } = poolWith(calls, {
      click: async () => {
        await Bun.sleep(30);
        order.push("click");
      },
    });
    await opened(pool, "a");
    const ctx = stub.contexts[0];
    const popup = {
      url: () => "https://popup.test/",
      title: async () => "Popup",
      isClosed: () => false,
      close: async () => {},
      innerText: async () => "popup text",
    };
    const action = pool.run("a", { action: "click", selector: "#go" });
    ctx.emitPage(popup);
    const r = await action;
    // The click answered from the page it clicked, not the window that opened.
    expect(r.ok && r.url).toBe("https://example.test/a?token=secret");
    // The swap lands after it: the next action sees the window.
    const next = await pool.run("a", { action: "text" });
    expect(next.ok && next.url).toBe("https://popup.test/");
    expect(order).toEqual(["click"]);
    await pool.shutdown();
  });

  it("agent A's close cannot strand agent B on a closed browser", async () => {
    // The race this pins, reported by Isomux Reviewer 4. B is INSIDE
    // newContext, having already seen a connected browser, when A's close
    // removes the last recorded session and takes the office browser down. B
    // then resumes and installs a session on a browser that is gone. Per-agent
    // queues cannot see this, because the browser is shared: the lifecycle
    // steps need one office-wide serialization point, and B must hold it from
    // before it observes the browser until after it registers its session.
    const calls = freshCalls();
    let releaseNewContext: () => void = () => {};
    const { pool, stub } = poolWith(calls);

    // A owns the only context, created before any gate is armed.
    await opened(pool, "a");
    expect(calls.contexts).toBe(1);
    expect(calls.browserClosed).toBe(0);

    // Arm the gate, then park B inside newContext.
    stub.setGates(
      new Promise<void>((resolve) => {
        releaseNewContext = resolve;
      }),
    );
    const startingB = opened(pool, "b");
    await Bun.sleep(20);
    expect(calls.contexts).toBe(2); // B is inside newContext, not past it.

    // Now A closes. With the office lock this waits for B; without it, A
    // deletes the last session and closes the browser under B's feet.
    const closingA = pool.close("a");
    await Bun.sleep(20);
    releaseNewContext();
    const [resultB] = await Promise.all([startingB, closingA]);

    expect(resultB.ok).toBe(true);
    expect(pool.activeAgents()).toEqual(["b"]);
    // The discriminator: B's browser is alive, and nothing closed a browser,
    // because B's session was recorded before A's close counted the sessions.
    const contextB = stub.contexts[stub.contexts.length - 1];
    const browserB = stub.instances[contextB.browserId];
    expect(browserB.isConnected()).toBe(true);
    expect(calls.browserClosed).toBe(0);

    await pool.shutdown();
    expect(pool.activeAgents()).toEqual([]);
    expect(calls.browserClosed).toBe(1);
  });

  it("closing an agent that holds no context is a no-op", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    await pool.close("nobody");
    expect(calls.closedContexts).toBe(0);
    expect(calls.browserClosed).toBe(0);
  });

  it("resizes the shared viewport in order and restarts capture at the new bounds", async () => {
    const calls = freshCalls();
    let viewport = { width: 1280, height: 800 };
    const { pool } = poolWith(calls, {
      viewportSize: () => viewport,
      setViewportSize: async (next: typeof viewport) => {
        viewport = next;
      },
    });
    const edges: boolean[] = [];
    const stop = pool.watch("a", () => {
      const resizing = pool.status("a").resizing ?? false;
      if (edges.at(-1) !== resizing) edges.push(resizing);
    });
    try {
      await opened(pool, "a");
      await Promise.all([
        pool.humanInput("a", { kind: "viewport", width: 650, height: 900 }),
        pool.humanInput("a", { kind: "viewport", width: 390, height: 700 }),
      ]);
      expect(viewport).toEqual({ width: 390, height: 700 });
      expect(edges).toEqual([false, true, false, true, false]);
      expect(
        calls.cdp.filter((c) => c.method === "Page.startScreencast").at(-1)
          ?.params,
      ).toMatchObject({ maxWidth: 390, maxHeight: 700 });
      await pool.humanInput("a", { kind: "viewport", width: 1, height: 3000 });
      expect(viewport).toEqual({ width: 320, height: 2560 });
      await pool.run("a", { action: "text" });
      expect(viewport).toEqual({ width: 320, height: 2560 });
    } finally {
      stop();
      await pool.shutdown();
    }
  });

  it("drops mismatched frame metadata without caching it and publishes matching frames", async () => {
    const calls = freshCalls();
    const { pool, stub } = poolWith(calls);
    const frames: unknown[] = [];
    const stops = [
      pool.watch("a", (frame) => {
        if (frame) frames.push(frame);
      }),
    ];
    try {
      await opened(pool, "a");
      const emit = (data: string, width: number, height: number) => {
        stub.cdpSessions[0].emit("Page.screencastFrame", {
          data,
          sessionId: 1,
          metadata: { deviceWidth: width, deviceHeight: height },
        } as never);
      };
      // Test each axis independently; metadata must not be replaced by the viewport.
      for (const [width, height] of [
        [640, 800],
        [1280, 480],
      ]) {
        emit("stale", width, height);
        expect(frames).toEqual([]);
        const late: unknown[] = [];
        stops.push(
          pool.watch("a", (frame) => {
            if (frame) late.push(frame);
          }),
        );
        expect(late).toEqual([]); // a rejected frame must not become lastFrame
      }
      emit("current", 1280, 800);
      const expected = { data: "current", width: 1280, height: 800 };
      expect(frames).toEqual([expected]);
      const late: unknown[] = [];
      stops.push(
        pool.watch("a", (frame) => {
          if (frame) late.push(frame);
        }),
      );
      expect(late).toEqual([expected]); // a matching frame must become lastFrame
    } finally {
      for (const stop of stops) stop();
      await pool.shutdown();
    }
  });

  it("streams frames only while a viewer is attached and dispatches human input", async () => {
    const calls = freshCalls();
    const { pool, stub } = poolWith(calls);
    const frames: Array<unknown> = [];
    const stop = pool.watch("a", (frame) => frames.push(frame));
    expect(frames).toEqual([null]);

    await opened(pool, "a");
    expect(
      calls.cdp.some((call) => call.method === "Page.startScreencast"),
    ).toBe(true);
    const stopSecond = pool.watch("a", () => {});
    expect(
      calls.cdp.filter((call) => call.method === "Page.startScreencast"),
    ).toHaveLength(1);
    stub.cdpSessions[0].emit("Page.screencastFrame", {
      data: "jpeg",
      sessionId: 7,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    } as never);
    expect(frames.at(-1)).toEqual({ data: "jpeg", width: 1280, height: 800 });
    expect(
      calls.cdp.some((call) => call.method === "Page.screencastFrameAck"),
    ).toBe(true);

    expect(
      await pool.humanInput("a", {
        kind: "mouse",
        event: "mousePressed",
        x: 12,
        y: 18,
        button: "left",
        clickCount: 1,
      }),
    ).toBe(true);
    expect(
      calls.cdp.find((call) => call.method === "Input.dispatchMouseEvent"),
    ).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 12,
        y: 18,
        button: "left",
        clickCount: 1,
      },
    });

    stop();
    await Bun.sleep(0);
    expect(
      calls.cdp.some((call) => call.method === "Page.stopScreencast"),
    ).toBe(false);
    stopSecond();
    await Bun.sleep(0);
    expect(
      calls.cdp.some((call) => call.method === "Page.stopScreencast"),
    ).toBe(true);
    await pool.shutdown();
  });

  it("seeds a quiet page and never replaces a newer live frame with the seed", async () => {
    for (const live of [false, true]) {
      const calls = freshCalls();
      let resolve!: (shot: { data: string }) => void;
      const screenshot = new Promise<{ data: string }>((done) => {
        resolve = done;
      });
      const { pool, stub } = poolWith(calls, {}, 60_000, {
        screenshot: () => screenshot,
      });
      await opened(pool, "quiet");
      const frames: unknown[] = [];
      const stop = pool.watch("quiet", (frame) => {
        if (frame) frames.push(frame);
      });
      await Bun.sleep(0);
      if (live)
        stub.cdpSessions[0].emit("Page.screencastFrame", {
          data: "live",
          sessionId: 1,
        } as never);
      resolve({ data: "seed" });
      await Bun.sleep(0);
      expect(frames).toEqual([
        { data: live ? "live" : "seed", width: 1280, height: 800 },
      ]);
      const late: unknown[] = [];
      const stopLate = pool.watch(
        "quiet",
        (frame) => {
          if (frame) late.push(frame);
        },
        () => false,
      );
      expect(late).toEqual(frames);
      stopLate();
      stop();
      await pool.shutdown();
    }
  });

  it("capture follows the largest watcher on join, grow and departure", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls);
    const starts = () =>
      calls.cdp.filter((call) => call.method === "Page.startScreencast");
    const size = () => {
      const p = starts().at(-1)!.params!;
      return [p.maxWidth, p.maxHeight];
    };
    const settle = () => Bun.sleep(0);
    let stopA = pool.watch(
      "a",
      () => {},
      () => true,
      { maxWidth: 400, maxHeight: 320 },
    );
    await opened(pool, "a");
    expect(size()).toEqual([400, 320]);
    const stopB = pool.watch(
      "a",
      () => {},
      () => false,
      { maxWidth: 800, maxHeight: 600 },
    );
    await settle();
    expect(size()).toEqual([800, 600]);
    const count = starts().length;
    const stopC = pool.watch(
      "a",
      () => {},
      () => false,
      { maxWidth: 500, maxHeight: 400 },
    );
    await settle();
    expect(starts()).toHaveLength(count);
    stopA();
    stopA = pool.watch(
      "a",
      () => {},
      () => true,
      { maxWidth: 1000, maxHeight: 700 },
    );
    await settle();
    expect(size()).toEqual([1000, 700]);
    stopA();
    await settle();
    expect(size()).toEqual([800, 600]);
    stopB();
    await settle();
    expect(size()).toEqual([500, 400]);
    stopC();
    await pool.shutdown();
  });

  it("an attached viewer suspends idle close until the viewer leaves", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, undefined, 200);
    const stop = pool.watch("a", () => {});
    await opened(pool, "a");
    await Bun.sleep(230);
    expect(pool.activeAgents()).toEqual(["a"]);
    expect(
      await pool.humanInput("a", {
        kind: "key",
        event: "keyDown",
        key: "a",
        text: "a",
      }),
    ).toBe(true);
    stop();
    await Bun.sleep(230);
    expect(pool.activeAgents()).toEqual([]);
    await pool.shutdown();
  });

  it("room viewers do not suspend idle close", async () => {
    const calls = freshCalls();
    const { pool } = poolWith(calls, undefined, 80);
    const stop = pool.watch(
      "a",
      () => {},
      () => false,
    );
    await opened(pool, "a");
    await Bun.sleep(110);
    expect(pool.activeAgents()).toEqual([]);
    stop();
    await pool.shutdown();
  });

  it("human open and goto let the agent act; human close leaves no page", async () => {
    const calls = freshCalls();
    let url = "about:blank";
    const { pool } = poolWith(calls, {
      url: () => url,
      goto: async (next: string) => {
        url = next;
      },
    });
    expect(
      (
        await pool.humanNavigate(
          "a",
          { kind: "navigate", action: "open" },
          "boss",
        )
      ).ok,
    ).toBe(true);
    expect(pool.status("a").available).toBe(true);
    expect(
      (
        await pool.humanNavigate(
          "a",
          { kind: "navigate", action: "goto", url: "file:///tmp/page" },
          "boss",
        )
      ).ok,
    ).toBe(false);
    await pool.humanNavigate(
      "a",
      { kind: "navigate", action: "goto", url: "https://example.test" },
      "boss",
    );
    expect(
      (await pool.run("a", { action: "click", selector: "button" })).ok,
    ).toBe(true);
    await pool.humanNavigate(
      "a",
      { kind: "navigate", action: "close" },
      "boss",
    );
    expect(pool.status("a").available).toBe(false);
    const result = await pool.run("a", { action: "click", selector: "button" });
    expect(!result.ok && result.code).toBe("no_page");
    await pool.shutdown();
  });

  it("only an agent goto creating a fresh page reports createdPage", async () => {
    const { pool } = poolWith(freshCalls());
    const first = await pool.run("a", {
      action: "goto",
      url: "https://example.test",
    });
    expect(first.ok && first.createdPage).toBe(true);
    const next = await pool.run("a", {
      action: "goto",
      url: "https://example.test/next",
    });
    expect(next.ok && next.createdPage).toBeUndefined();
    const close = await pool.run("a", { action: "close" });
    expect(close.ok && close.createdPage).toBeUndefined();
    const fresh = await pool.run("a", {
      action: "goto",
      url: "https://example.test",
    });
    expect(fresh.ok && fresh.createdPage).toBe(true);
    await pool.shutdown();
  });

  it("human navigation waits for the agent action queue", async () => {
    const calls = freshCalls();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let began!: () => void;
    const started = new Promise<void>((r) => (began = r));
    const { pool } = poolWith(calls, {
      click: async () => {
        began();
        await gate;
        calls.actions.push("click-done");
      },
      goBack: async () => {
        calls.actions.push("back");
      },
    });
    await opened(pool, "a");
    const click = pool.run("a", { action: "click", selector: "button" });
    await started;
    const back = pool.humanNavigate(
      "a",
      { kind: "navigate", action: "back" },
      "boss",
    );
    expect(calls.actions).not.toContain("back");
    release();
    await click;
    await back;
    expect(calls.actions.slice(-2)).toEqual(["click-done", "back"]);
    await pool.shutdown();
  });

  it("human input interleaves with an agent action instead of waiting for its queue", async () => {
    const calls = freshCalls();
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => {
      releaseClick = resolve;
    });
    const { pool } = poolWith(calls, { click: async () => clickGate });
    const stop = pool.watch("a", () => {});
    await opened(pool, "a");
    const clicking = pool.run("a", { action: "click", selector: "button" });
    await Bun.sleep(0);

    const winner = await Promise.race([
      pool
        .humanInput("a", {
          kind: "key",
          event: "keyDown",
          key: "Escape",
        })
        .then(() => "input"),
      Bun.sleep(150).then(() => "timeout"),
    ]);
    releaseClick();
    await clicking;
    expect(winner).toBe("input");
    expect(calls.cdp.at(-1)?.method).toBe("Input.dispatchKeyEvent");
    stop();
    await pool.shutdown();
  });
});

it("shared capture follows the best viewer demand, scales within client bounds and rejects cached old bounds", async () => {
  const calls = freshCalls();
  const { pool, stub } = poolWith(calls);
  let level = 0;
  const slowFrames: unknown[] = [];
  const stop = pool.watch(
    "adapt",
    (f) => slowFrames.push(f),
    () => true,
    { maxWidth: 640, maxHeight: 400 },
    () => level,
  );
  try {
    await opened(pool, "adapt");
    const latest = () =>
      calls.cdp.filter((c) => c.method === "Page.startScreencast").at(-1)
        ?.params;
    expect(latest()).toMatchObject({
      quality: 50,
      maxWidth: 640,
      maxHeight: 400,
    });
    level = 2;
    pool.refreshCapture("adapt");
    await Bun.sleep(0);
    expect(latest()).toMatchObject({
      quality: 20,
      maxWidth: 640,
      maxHeight: 400,
    });
    level = 3;
    pool.refreshCapture("adapt");
    await Bun.sleep(0);
    expect(latest()).toMatchObject({
      quality: 20,
      maxWidth: 480,
      maxHeight: 300,
    });
    const fast = pool.watch(
      "adapt",
      () => {},
      () => true,
      { maxWidth: 640, maxHeight: 400 },
    );
    await Bun.sleep(0);
    expect(latest()).toMatchObject({
      quality: 50,
      maxWidth: 640,
      maxHeight: 400,
    });
    fast();
    await Bun.sleep(0);
    expect(latest()).toMatchObject({
      quality: 20,
      maxWidth: 480,
      maxHeight: 300,
    });
    stub.cdpSessions
      .at(-1)!
      .emit("Page.screencastFrame", { data: "old", sessionId: 1 } as never);
    stop();
    const resized: unknown[] = [];
    const stopResized = pool.watch(
      "adapt",
      (f) => resized.push(f),
      () => true,
      { maxWidth: 400, maxHeight: 240 },
      () => level,
    );
    expect(resized).toEqual([null]);
    await Bun.sleep(0);
    expect(latest()).toMatchObject({
      quality: 20,
      maxWidth: 300,
      maxHeight: 180,
    });
    stopResized();
  } finally {
    stop();
    await pool.shutdown();
  }
});

it("reads only the active selection, caps it, and does not open a missing page", async () => {
  let selected = "";
  const calls = freshCalls();
  const { pool } = poolWith(calls, {
    evaluate: async (fn: (limit: number) => unknown, limit: number) =>
      runInNewContext(`(${fn.toString()})(${limit})`, {
        window: { getSelection: () => ({ toString: () => selected }) },
      }),
  });
  try {
    expect(
      await pool.selection("missing").then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(calls.contexts).toBe(0);
    await pool.run("selected", { action: "goto", url: "https://example.test" });
    expect(await pool.selection("selected")).toEqual({
      text: "",
      truncated: false,
    });
    selected = "selected words";
    expect(await pool.selection("selected")).toEqual({
      text: selected,
      truncated: false,
    });
    selected = "x".repeat(MAX_TEXT_CHARS + 1);
    expect(await pool.selection("selected")).toEqual({
      text: "x".repeat(MAX_TEXT_CHARS),
      truncated: true,
    });
    expect(calls.actions).toHaveLength(1);
  } finally {
    await pool.shutdown();
  }
});

async function untilBrowser(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("browser condition did not arrive");
    await Bun.sleep(5);
  }
}

it("captures the latest input after repaint even when a stale stream frame arrived while settling", async () => {
  const calls = freshCalls();
  let paint!: () => void;
  let evaluating = false;
  let painted = "before";
  const barrier = new Promise<void>((resolve) => {
    paint = resolve;
  });
  let shots = 0;
  const { pool, stub } = poolWith(calls, {}, 60_000, {
    send: async (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 7 };
      if (method === "Runtime.evaluate") {
        evaluating = true;
        await barrier;
      }
      if (method === "Page.captureScreenshot") {
        shots++;
        return { data: painted };
      }
    },
  });
  const frames: string[] = [];
  const stop = pool.watch("paint", (f) => {
    if (f) frames.push(f.data);
  });
  try {
    await opened(pool, "paint");
    await untilBrowser(() => frames.includes("before"));
    frames.length = 0;
    shots = 0;
    await pool.humanInput("paint", {
      kind: "key",
      event: "char",
      key: "a",
      text: "a",
    });
    await pool.humanInput("paint", {
      kind: "key",
      event: "char",
      key: "b",
      text: "b",
    });
    await untilBrowser(() => evaluating || frames.length > 0);
    expect(frames).toEqual([]); // a dispatch-time capture still contains the old paint
    stub.cdpSessions
      .at(-1)!
      .emit("Page.screencastFrame", { data: "stale", sessionId: 1 } as never);
    painted = "both keys painted";
    paint();
    await untilBrowser(() => frames.includes("both keys painted"));
    expect(frames).toEqual(["stale", "both keys painted"]);
    expect(shots).toBe(1);
    expect(
      calls.cdp.find((c) => c.method === "Runtime.evaluate")?.params?.contextId,
    ).toBe(7);
  } finally {
    paint();
    stop();
    await pool.shutdown();
  }
});

it("coalesces a drag into one still and captures when the paint barrier times out", async () => {
  const calls = freshCalls();
  let shots = 0;
  const { pool } = poolWith(calls, {}, 60_000, {
    send: async (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") return new Promise(() => {});
      if (method === "Page.captureScreenshot") {
        shots++;
        return { data: "final" };
      }
    },
  });
  const frames: string[] = [];
  const stop = pool.watch("drag", (f) => {
    if (f) frames.push(f.data);
  });
  try {
    await opened(pool, "drag");
    await untilBrowser(() => frames.length > 0);
    shots = 0;
    frames.length = 0;
    for (let x = 0; x < 50; x++)
      await pool.humanInput("drag", {
        kind: "mouse",
        event: "mouseMoved",
        x,
        y: 20,
      });
    await untilBrowser(() => frames.length > 0);
    expect(shots).toBe(1);
    expect(frames).toEqual(["final"]);
  } finally {
    stop();
    await pool.shutdown();
  }
});

it("drops a late input still after a live frame, stop, resize or close and catches capture failure", async () => {
  for (const edge of ["live", "stop", "resize", "close", "reject"] as const) {
    const calls = freshCalls();
    let resolve!: (shot: { data: string }) => void;
    let reject!: (reason: Error) => void;
    const shot = new Promise<{ data: string }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let armed = false,
      capturing = false;
    let viewport = { width: 1280, height: 800 };
    const { pool, stub } = poolWith(
      calls,
      {
        viewportSize: () => viewport,
        setViewportSize: async (v: typeof viewport) => {
          viewport = v;
        },
      },
      60_000,
      {
        screenshot: async () => {
          if (!armed) return { data: "seed" };
          capturing = true;
          return shot;
        },
      },
    );
    const frames: string[] = [];
    const stop = pool.watch("late", (f) => {
      if (f) frames.push(f.data);
    });
    try {
      await opened(pool, "late");
      frames.length = 0;
      armed = true;
      await pool.humanInput("late", { kind: "key", event: "char", key: "x" });
      await untilBrowser(() => capturing);
      armed = false;
      if (edge === "live")
        stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
          data: "live",
          sessionId: 1,
        } as never);
      if (edge === "stop") {
        stop();
        await Bun.sleep(0);
      }
      if (edge === "resize")
        await pool.humanInput("late", {
          kind: "viewport",
          width: 400,
          height: 680,
        });
      if (edge === "close") await pool.close("late");
      if (edge === "reject") reject(new Error("capture failed"));
      else resolve({ data: "obsolete" });
      await Bun.sleep(0);
      expect(frames.includes("obsolete")).toBe(false);
      if (edge === "live") expect(frames).toEqual(["live"]);
      if (edge === "reject") {
        await pool.humanInput("late", { kind: "key", event: "char", key: "y" });
        await untilBrowser(() => frames.includes("seed"));
      }
    } finally {
      resolve({ data: "done" });
      stop();
      await pool.shutdown();
    }
  }
});

it("uses the highest watcher DPR, preserves CSS input and screenshot geometry, and caps physical capture", async () => {
  const calls = freshCalls();
  let viewport = { width: 1600, height: 900 };
  let screenshotOptions: Record<string, unknown> | undefined;
  const { pool, stub } = poolWith(calls, {
    viewportSize: () => viewport,
    setViewportSize: async (v: typeof viewport) => {
      viewport = v;
    },
    screenshot: async (options: Record<string, unknown>) => {
      screenshotOptions = options;
      return Buffer.from("PNG");
    },
  });
  const starts = () =>
    calls.cdp.filter((c) => c.method === "Page.startScreencast");
  const metrics = () =>
    calls.cdp
      .filter((c) => c.method === "Emulation.setDeviceMetricsOverride")
      .at(-1)?.params;
  const stops: (() => void)[] = [];
  const watch = (dpr: number, bounds = {}) => {
    const stop = pool.watch(
      "dpr",
      () => {},
      () => true,
      { deviceScaleFactor: dpr, ...bounds },
    );
    stops.push(stop);
    return stop;
  };
  try {
    watch(1);
    await opened(pool, "dpr");
    expect(metrics()).toBeUndefined();
    const high = watch(2);
    await untilBrowser(() => metrics()?.deviceScaleFactor === 2);
    await Bun.sleep(0);
    expect(starts().at(-1)?.params).toMatchObject({
      maxWidth: 1600,
      maxHeight: 900,
      everyNthFrame: 1,
    });
    expect(metrics()).toEqual({
      width: 1600,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(calls.cdp.some((c) => c.method === "Emulation.setVisibleSize")).toBe(
      false,
    );
    await untilBrowser(() =>
      calls.cdp.some(
        (c) =>
          c.method === "Page.captureScreenshot" &&
          (c.params?.clip as { scale?: number } | undefined)?.scale === 0.8,
      ),
    );
    const count = starts().length;
    const low = watch(1);
    await Bun.sleep(0);
    expect(starts()).toHaveLength(count);
    const frames: unknown[] = [];
    const frameStop = pool.watch("dpr", (f) => {
      if (f) frames.push(f);
    });
    stops.push(frameStop);
    stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
      data: "retina",
      sessionId: 1,
      metadata: { deviceWidth: 2560, deviceHeight: 1440 },
    } as never);
    expect(frames.some((f) => (f as { data: string }).data === "retina")).toBe(
      false,
    );
    await pool.humanInput("dpr", {
      kind: "mouse",
      event: "mousePressed",
      x: 110,
      y: 230,
    });
    expect(
      calls.cdp.find((c) => c.method === "Input.dispatchMouseEvent")?.params,
    ).toMatchObject({ x: 110, y: 230 });
    await pool.humanInput("dpr", { kind: "viewport", width: 400, height: 680 });
    expect(metrics()).toMatchObject({
      width: 400,
      height: 680,
      deviceScaleFactor: 2,
    });
    expect(starts().at(-1)?.params).toMatchObject({
      maxWidth: 400,
      maxHeight: 680,
      everyNthFrame: 1,
    });
    await untilBrowser(
      () =>
        (
          calls.cdp.filter((c) => c.method === "Page.captureScreenshot").at(-1)
            ?.params?.clip as { width?: number } | undefined
        )?.width === 400,
    );
    expect(
      calls.cdp.filter((c) => c.method === "Page.captureScreenshot").at(-1)
        ?.params?.clip,
    ).toEqual({ x: 0, y: 0, width: 400, height: 680, scale: 1 });
    await pool.run("dpr", { action: "screenshot" });
    expect(screenshotOptions?.scale).toBe("css");
    expect(metrics()?.deviceScaleFactor).toBe(2);
    high();
    await untilBrowser(() => starts().at(-1)?.params?.everyNthFrame === 2);
    low();
    frameStop();
    const fractional = watch(1.5);
    await untilBrowser(() => metrics()?.deviceScaleFactor === 1.5);
    fractional();
    const huge = watch(50);
    await untilBrowser(() => metrics()?.deviceScaleFactor === 4);
    huge();
  } finally {
    for (const stop of stops) stop();
    await pool.shutdown();
  }
});

it("restarts the paint barrier when input arrives during settlement", async () => {
  const calls = freshCalls();
  const barriers: (() => void)[] = [];
  let shots = 0;
  const { pool } = poolWith(calls, {}, 60_000, {
    send: async (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate")
        return new Promise<void>((resolve) => barriers.push(resolve));
      if (method === "Page.captureScreenshot") {
        shots++;
        return { data: "frame" };
      }
    },
  });
  const stop = pool.watch("trailing", () => {});
  try {
    await opened(pool, "trailing");
    await untilBrowser(() => shots === 1);
    shots = 0;
    await pool.humanInput("trailing", { kind: "key", event: "char", key: "a" });
    await untilBrowser(() => barriers.length === 1);
    await pool.humanInput("trailing", { kind: "key", event: "char", key: "b" });
    barriers[0]();
    await untilBrowser(() => barriers.length === 2);
    expect(shots).toBe(0);
    barriers[1]();
    await untilBrowser(() => shots === 1);
  } finally {
    for (const done of barriers) done();
    stop();
    await pool.shutdown();
  }
});

it("seeds the view when the first stream frame has mismatched dimensions", async () => {
  const calls = freshCalls();
  let resolve!: (shot: { data: string }) => void;
  const shot = new Promise<{ data: string }>((done) => {
    resolve = done;
  });
  const { pool, stub } = poolWith(calls, {}, 60_000, {
    screenshot: () => shot,
  });
  const frames: string[] = [];
  const stop = pool.watch(
    "old-dimensions",
    (frame) => {
      if (frame) frames.push(frame.data);
    },
    () => true,
    { deviceScaleFactor: 1 },
  );
  try {
    await opened(pool, "old-dimensions");
    await untilBrowser(() =>
      calls.cdp.some((c) => c.method === "Page.captureScreenshot"),
    );
    stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
      data: "old-dpr",
      sessionId: 1,
      metadata: { deviceWidth: 640, deviceHeight: 400 },
    } as never);
    resolve({ data: "retina-seed" });
    await Bun.sleep(0);
    expect(frames).toEqual(["retina-seed"]);
  } finally {
    resolve({ data: "done" });
    stop();
    await pool.shutdown();
  }
});

it("throttles DPR triggers without starving motion and keeps the final change", async () => {
  const calls = freshCalls();
  let value = 0,
    shots = 0,
    inFlight = 0,
    maxInFlight = 0;
  const { pool, stub } = poolWith(calls, {}, 60_000, {
    screenshot: async () => {
      shots++;
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      const data = `sharp-${value}`;
      await Bun.sleep(65);
      inFlight--;
      return { data };
    },
  });
  const frames: string[] = [];
  const stop = pool.watch(
    "motion",
    (f) => {
      if (f) frames.push(f.data);
    },
    () => true,
    { deviceScaleFactor: 2 },
  );
  try {
    await opened(pool, "motion");
    await untilBrowser(() => frames.length > 0);
    frames.length = 0;
    shots = 0;
    const started = Date.now();
    while (Date.now() - started < 2000) {
      value++;
      stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
        data: `trigger-${value}`,
        sessionId: value,
      } as never);
      await Bun.sleep(16);
    }
    await untilBrowser(() => frames.at(-1) === `sharp-${value}`);
    expect(frames.length).toBeGreaterThanOrEqual(20);
    expect(frames.length).toBeLessThanOrEqual(34);
    expect(frames.every((f) => f.startsWith("sharp-"))).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(shots).toBe(frames.length);
    expect(calls.cdp.some((c) => c.method === "Runtime.evaluate")).toBe(false);
    const count = shots;
    stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
      data: `trigger-${value}`,
      sessionId: value + 1,
    } as never);
    await Bun.sleep(100);
    expect(shots).toBe(count);
  } finally {
    stop();
    await pool.shutdown();
  }
});

it("queues human input across the entire DPR agent screenshot and restore", async () => {
  const calls = freshCalls();
  let finish!: () => void,
    screenshotStarted = false;
  const screenshot = new Promise<void>((done) => {
    finish = done;
  });
  const { pool } = poolWith(calls, {
    screenshot: async () => {
      expect(
        calls.cdp
          .filter((c) => c.method === "Emulation.setDeviceMetricsOverride")
          .at(-1)?.params,
      ).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1 });
      screenshotStarted = true;
      await screenshot;
      return Buffer.from("PNG");
    },
  });
  const stop = pool.watch(
    "race",
    () => {},
    () => true,
    { deviceScaleFactor: 2 },
  );
  try {
    await opened(pool, "race");
    const shot = pool.run("race", { action: "screenshot" });
    await untilBrowser(() => screenshotStarted);
    const mouse = pool.humanInput("race", {
      kind: "mouse",
      event: "mousePressed",
      x: 330,
      y: 520,
    });
    await Bun.sleep(10);
    expect(
      calls.cdp.filter((c) => c.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(0);
    finish();
    expect((await shot).ok).toBe(true);
    expect(await mouse).toBe(true);
    const inputs = calls.cdp.filter(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0].params).toMatchObject({ x: 330, y: 520 });
  } finally {
    finish();
    stop();
    await pool.shutdown();
  }
});

it("pauses capture only when every watcher is blocked", async () => {
  const calls = freshCalls();
  let ready = false,
    shots = 0;
  const { pool, stub } = poolWith(calls, {}, 60_000, {
    screenshot: async () => ({ data: `sharp-${++shots}` }),
  });
  const frames: string[] = [];
  const stop = pool.watch(
    "pressure",
    (f) => {
      if (f) frames.push(f.data);
    },
    () => true,
    { deviceScaleFactor: 2 },
    () => 0,
    () => ready,
  );
  let fast = () => {};
  try {
    await opened(pool, "pressure");
    await Bun.sleep(100);
    expect(shots).toBe(0);
    fast = pool.watch(
      "pressure",
      () => {},
      () => true,
      { deviceScaleFactor: 1 },
    );
    await untilBrowser(() => shots > 0);
    fast();
    await Bun.sleep(10);
    const count = shots;
    stub.cdpSessions
      .at(-1)!
      .emit("Page.screencastFrame", { data: "new", sessionId: 1 } as never);
    await Bun.sleep(100);
    expect(shots).toBe(count);
    ready = true;
    await untilBrowser(() => shots === count + 1);
    expect(frames.at(-1)).toBe(`sharp-${shots}`);
  } finally {
    fast();
    stop();
    await pool.shutdown();
  }
});

it("restores fresh watcher DPR after a screenshot and recovers from a failed restore", async () => {
  for (const failRestore of [false, true]) {
    const calls = freshCalls();
    let finish!: () => void,
      started = false,
      rejectRestore = false;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    const { pool } = poolWith(
      calls,
      {
        screenshot: async () => {
          started = true;
          await gate;
          return Buffer.from("PNG");
        },
      },
      60_000,
      {
        send: async (method) => {
          if (method === "Emulation.setDeviceMetricsOverride" && rejectRestore)
            throw Error("restore failed");
          if (method === "Page.captureScreenshot") return { data: "sharp" };
        },
      },
    );
    const frames: (string | null)[] = [];
    const low = pool.watch(
      "restore",
      (f) => frames.push(f?.data ?? null),
      () => true,
      { deviceScaleFactor: 1.5 },
    );
    const high = pool.watch(
      "restore",
      () => {},
      () => true,
      { deviceScaleFactor: 2 },
    );
    try {
      await opened(pool, "restore");
      await untilBrowser(() => frames.includes("sharp"));
      const shot = pool.run("restore", { action: "screenshot" });
      await untilBrowser(() => started);
      high();
      rejectRestore = failRestore;
      frames.length = 0;
      finish();
      await shot;
      const metrics = calls.cdp
        .filter((c) => c.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.params;
      expect(
        calls.cdp.some(
          (c) =>
            c.method === "Emulation.setDeviceMetricsOverride" &&
            c.params?.deviceScaleFactor === 1.5,
        ),
      ).toBe(true);
      expect(metrics?.deviceScaleFactor).toBe(failRestore ? 1 : 1.5);
      if (failRestore) {
        expect(frames.includes("sharp")).toBe(false);
        expect(frames.at(-1)).toBeNull();
        rejectRestore = false;
        pool.refreshCapture("restore");
      }
      await untilBrowser(() => frames.includes("sharp"));
    } finally {
      finish();
      high();
      low();
      await pool.shutdown();
    }
  }
});

it("rejects the old seed and stream when a DPR watcher joins during start", async () => {
  const calls = freshCalls();
  let finish!: (shot: { data: string }) => void,
    shots = 0;
  const seed = new Promise<{ data: string }>((done) => {
    finish = done;
  });
  const { pool, stub } = poolWith(calls, {}, 60_000, {
    screenshot: async () => (++shots === 1 ? seed : { data: "sharp" }),
  });
  const low = pool.watch("join-start", () => {});
  let high = () => {};
  const frames: string[] = [];
  try {
    await opened(pool, "join-start");
    await untilBrowser(() => shots === 1);
    high = pool.watch(
      "join-start",
      (f) => {
        if (f) frames.push(f.data);
      },
      () => true,
      { deviceScaleFactor: 2 },
    );
    stub.cdpSessions[0].emit("Page.screencastFrame", {
      data: "old-stream",
      sessionId: 1,
    } as never);
    finish({ data: "old-seed" });
    await untilBrowser(() => frames.includes("sharp"));
    expect(frames).toEqual(["sharp"]);
  } finally {
    finish({ data: "done" });
    high();
    low();
    await pool.shutdown();
  }
});

it("keeps DPR 1 screenshots and shutdown free of emulation commands", async () => {
  const calls = freshCalls();
  const { pool } = poolWith(calls);
  const stop = pool.watch("plain", () => {});
  try {
    await opened(pool, "plain");
    const count = calls.cdp.filter(
      (c) => c.method === "Page.startScreencast",
    ).length;
    await pool.run("plain", { action: "screenshot" });
    expect(
      calls.cdp.filter((c) => c.method === "Page.startScreencast"),
    ).toHaveLength(count);
    stop();
    await Bun.sleep(0);
    expect(calls.cdp.some((c) => c.method.startsWith("Emulation."))).toBe(
      false,
    );
  } finally {
    stop();
    await pool.shutdown();
  }
});

for (const [kind, interval] of [
  ["hover", 16],
  ["typing", 80],
] as const) {
  it(`delivers DPR stills during continuous ${kind} and ends with the final input`, async () => {
    const calls = freshCalls();
    let value = 0,
      inFlight = 0,
      maxInFlight = 0;
    const { pool, stub } = poolWith(calls, {}, 60_000, {
      send: async (method) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "root" } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 1 };
        if (method === "Runtime.evaluate") await Bun.sleep(33);
        if (method === "Page.captureScreenshot") {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          const data = `paint-${value}`;
          await Bun.sleep(65);
          inFlight--;
          return { data };
        }
      },
    });
    const frames: string[] = [];
    const stop = pool.watch(
      "continuous",
      (f) => {
        if (f) frames.push(f.data);
      },
      () => true,
      { deviceScaleFactor: 2 },
    );
    try {
      await opened(pool, "continuous");
      await untilBrowser(() => frames.length > 0);
      frames.length = 0;
      const started = Date.now();
      while (Date.now() - started < 2000) {
        value++;
        await pool.humanInput(
          "continuous",
          kind === "hover"
            ? { kind: "mouse", event: "mouseMoved", x: value, y: 20 }
            : { kind: "key", event: "char", key: "a", text: "a" },
        );
        stub.cdpSessions.at(-1)!.emit("Page.screencastFrame", {
          data: `trigger-${value}`,
          sessionId: value,
        } as never);
        await Bun.sleep(interval);
      }
      const during = frames.length;
      expect(during).toBeGreaterThanOrEqual(15);
      expect(during).toBeLessThanOrEqual(23);
      await untilBrowser(() => frames.at(-1) === `paint-${value}`);
      expect(maxInFlight).toBe(1);
      console.log(
        JSON.stringify({
          continuousInput: kind,
          inputIntervalMs: interval,
          barrierMs: 33,
          captureMs: 65,
          during,
          total: frames.length,
          final: frames.at(-1),
          inputs: value,
        }),
      );
    } finally {
      stop();
      await pool.shutdown();
    }
  });
}
