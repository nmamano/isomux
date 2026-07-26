// In-process server test harness (Phase 0.3). Boots the REAL server
// (startServer from server/isomux-office.ts) against the temp STATE_ROOT the test
// preload set up, with a FakeBackend injected so no LLM/provider call happens.
// Gives a test multiple authenticated users + sockets and lets it assert on the
// persisted files under STATE_ROOT.
//
// Single live instance per process: STATE_ROOT, the auth/users module caches,
// and the cron module-read bridge are process-global, so two concurrent harness
// servers would corrupt each other. startTestServer() throws if one is already
// active; stop() releases the lock. Fine for the T1 tier, which runs serially.
//
// Not imported by any production path.
import { mkdirSync } from "fs";
import {
  startServer,
  type ServerHandle,
  type StartServerOpts,
} from "../isomux-office.ts";
import { STATE_ROOT } from "../config.ts";
import { FakeBackend } from "./fake-backend.ts";
import { assertSafeToDelete, removeStateDir } from "./temp-state.ts";
import {
  COOKIE_NAME,
  buildPublicOrigin,
  acceptInvite,
  mintInvite,
  _testResetState,
  _testSeedOwner,
} from "../auth.ts";
import { _testResetUsers } from "../users.ts";
import { _testResetTokens } from "../identity/tokens.ts";
import { _testResetSkillUsage } from "../skill-usage.ts";
import { registerProductionCronjobManagerForModuleReads } from "../cronjob-manager.ts";
import type { UserRole } from "../../shared/types.ts";

export interface SeededIdentity {
  username: string;
  role: UserRole;
  // The raw session cookie value (isomux_session). Pass to connectWs/http.
  rawSessionId: string;
}

export interface TestSocket {
  raw: WebSocket;
  // Every parsed inbound message, in arrival order.
  messages: unknown[];
  // Resolve with the next (or already-buffered) message whose `type` matches.
  // Rejects after timeoutMs so a missing message fails fast, never hangs.
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(obj: unknown): void;
  close(): void;
}

export interface TestServer extends ServerHandle {
  stateRoot: string;
  fakeBackend: FakeBackend;
  baseUrl: string;
  // Seed the office's first owner (real mint+accept). Returns the cookie value.
  seedOwner(displayName?: string): Promise<SeededIdentity>;
  // Seed a member user (requires an existing owner). Real mint+accept.
  seedMember(displayName: string): Promise<SeededIdentity>;
  // fetch() against the server with the right Origin and an optional cookie.
  http(
    path: string,
    init?: RequestInit & { rawSessionId?: string },
  ): Promise<Response>;
  // Open a real authenticated WebSocket (cookie + matching Origin).
  connectWs(rawSessionId: string): Promise<TestSocket>;
  // COLD-RELOAD this server WITHOUT wiping STATE_ROOT: stops the current
  // instance and re-runs the real boot path against the on-disk state this run
  // persisted. Returns a FRESH TestServer (new port + handle); the old one is
  // dead. For persistence / boot-migration ORDERING tests — e.g. asserting the
  // 3b owner-access migration runs at boot against real persisted owners +
  // rooms. Test-support ONLY; see bootTestServer's header.
  restart(): Promise<TestServer>;
}

export interface StartTestServerOpts {
  // Inject a pre-configured FakeBackend (e.g. a custom onSend / auth-error
  // predicate). Default: a FakeBackend that auto-completes each turn on send.
  fakeBackend?: FakeBackend;
  // Extra startServer opts merged over the harness defaults. Rarely needed.
  startServer?: Partial<StartServerOpts>;
}

// Process-global single-instance guard (see file header).
let activeHarness = false;

export async function startTestServer(
  opts: StartTestServerOpts = {},
): Promise<TestServer> {
  return bootTestServer(opts, { wipe: true });
}

// Boot (or RE-boot, via restart()) a harness server. `wipe` controls whether
// STATE_ROOT is reset to empty first:
//   - startTestServer() passes wipe:true for a clean slate per test.
//   - restart() passes wipe:false to COLD-RELOAD the same on-disk state, the
//     seam persistence / migration-ordering tests need.
// EITHER WAY the in-memory module caches that lazy-load from STATE_ROOT are
// reset, so a restart is a TRUE cold boot that re-reads every persisted file —
// the only difference from a fresh boot is that the files survive. The boot is
// single-instance guarded like a fresh boot (preserving STATE_ROOT while a
// second server existed would be unsafe). Test-support ONLY; never production.
async function bootTestServer(
  opts: StartTestServerOpts,
  { wipe }: { wipe: boolean },
): Promise<TestServer> {
  if (activeHarness) {
    throw new Error(
      "startTestServer: a harness server is already active in this process. " +
        "The harness is single-instance-per-process (shared STATE_ROOT + module " +
        "caches); call stop() before starting another.",
    );
  }
  // Defense-in-depth: never run against anything but a temp STATE_ROOT. With the
  // test preload this always holds; without it (STATE_ROOT === ~/.isomux) this
  // throws before any wipe.
  assertSafeToDelete(STATE_ROOT);
  activeHarness = true;
  try {
    if (wipe) {
      // Clean slate per boot: wipe + recreate STATE_ROOT so each fresh harness
      // server starts empty. restart() skips this to preserve on-disk state.
      removeStateDir(STATE_ROOT);
      mkdirSync(STATE_ROOT, { recursive: true });
    }
    // Reset the module caches that lazy-load from STATE_ROOT — ALWAYS, even on a
    // no-wipe restart, so the re-boot re-reads the persisted files instead of
    // serving a stale in-memory cache from the prior instance.
    _testResetState();
    _testResetUsers();
    _testResetTokens();
    _testResetSkillUsage();
    registerProductionCronjobManagerForModuleReads(null);

    const fakeBackend =
      opts.fakeBackend ??
      new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      });

    const handle = await startServer({
      port: 0,
      resolveBackend: () => fakeBackend,
      skipSchedulers: true,
      skipBackups: true,
      skipAdminSocket: true,
      skipUpdateChecker: true,
      quiet: true,
      awaitRestore: true,
      ...opts.startServer,
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const sockets: TestSocket[] = [];

    async function seedOwner(displayName = "Owner"): Promise<SeededIdentity> {
      const r = await _testSeedOwner(displayName);
      return {
        username: r.username,
        role: r.role,
        rawSessionId: r.rawSessionId,
      };
    }

    async function seedMember(displayName: string): Promise<SeededIdentity> {
      const mint = await mintInvite({
        username: displayName,
        role: "member",
        createdBy: null,
        allowExisting: false,
      });
      if (!mint.ok) throw new Error(`seedMember: mint failed: ${mint.error}`);
      const acc = await acceptInvite(mint.rawToken, {
        userAgent: "test",
        chosenName: displayName,
      });
      if (!acc.ok) throw new Error(`seedMember: accept failed: ${acc.error}`);
      return {
        username: acc.username,
        role: acc.role,
        rawSessionId: acc.rawSessionId,
      };
    }

    function http(
      path: string,
      init: RequestInit & { rawSessionId?: string } = {},
    ): Promise<Response> {
      const { rawSessionId, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("Origin", buildPublicOrigin().origin);
      if (rawSessionId) headers.set("Cookie", `${COOKIE_NAME}=${rawSessionId}`);
      return fetch(`${baseUrl}${path}`, { ...rest, headers });
    }

    async function connectWs(rawSessionId: string): Promise<TestSocket> {
      // Bun's WebSocket client accepts a { headers } options object so the
      // upgrade carries the auth cookie + matching Origin. The DOM lib types
      // only the (url, protocols) overload, so cast through unknown; this is
      // runtime-correct under Bun.
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        headers: {
          Cookie: `${COOKIE_NAME}=${rawSessionId}`,
          Origin: buildPublicOrigin().origin,
        },
      } as unknown as string[]);
      const messages: Record<string, unknown>[] = [];
      const waiters: {
        type: string;
        resolve: (m: Record<string, unknown>) => void;
        timer: ReturnType<typeof setTimeout>;
      }[] = [];
      ws.addEventListener("message", (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(
            typeof ev.data === "string" ? ev.data : String(ev.data),
          );
        } catch {
          return;
        }
        messages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].type === msg.type) {
            clearTimeout(waiters[i].timer);
            waiters[i].resolve(msg);
            waiters.splice(i, 1);
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () =>
          reject(new Error("WebSocket connection failed (auth/origin?)")),
        );
      });
      const socket: TestSocket = {
        raw: ws,
        messages,
        waitFor(type, timeoutMs = 2000) {
          const existing = messages.find((m) => m.type === type);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              reject(
                new Error(`waitFor("${type}") timed out after ${timeoutMs}ms`),
              );
            }, timeoutMs);
            waiters.push({ type, resolve, timer });
          });
        },
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        close() {
          // Clear any pending waitFor timers so they cannot reject after the
          // test has moved on (a stray late unhandled rejection). The socket is
          // closing; nothing will arrive to satisfy them.
          for (const w of waiters) clearTimeout(w.timer);
          waiters.length = 0;
          try {
            ws.close();
          } catch {
            // already closing/closed
          }
        },
      };
      sockets.push(socket);
      return socket;
    }

    async function stop() {
      for (const s of sockets) s.close();
      try {
        // Bun 1.3.11 bug: server.stop() (graceful OR forced) NEVER resolves if
        // any ServerWebSocket was closed via ws.close() during the server's
        // life — which the production force-expire path does on session
        // revoke/logout (forceExpireSocketsForSession). Confirmed with a pure
        // Bun.serve repro (no isomux involved). The harness binds an EPHEMERAL
        // port (port:0), so a not-fully-drained server is inert and harmless
        // between serial boots; cap the wait so a wedged stop() can't hold the
        // single-instance lock forever. A clean stop resolves well under this
        // cap, so non-force-close tests pay no real cost. The .catch() keeps a
        // late stop() rejection from surfacing as an unhandled rejection after
        // the timeout already won the race.
        await Promise.race([
          handle.stop().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 500)),
        ]);
      } finally {
        // Release the single-instance lock even if handle.stop() hangs/throws,
        // so a failed teardown cannot wedge the whole test process.
        activeHarness = false;
      }
    }

    async function restart(): Promise<TestServer> {
      // Stop this instance (releases the single-instance lock) and re-boot
      // WITHOUT wiping STATE_ROOT, so every load() re-reads the files this run
      // persisted — exercising the real boot path (incl. boot migrations)
      // against real on-disk state. Returns the fresh TestServer.
      await stop();
      return bootTestServer(opts, { wipe: false });
    }

    return {
      ...handle,
      stateRoot: STATE_ROOT,
      fakeBackend,
      baseUrl,
      seedOwner,
      seedMember,
      http,
      connectWs,
      restart,
      stop,
    };
  } catch (err) {
    activeHarness = false;
    throw err;
  }
}
