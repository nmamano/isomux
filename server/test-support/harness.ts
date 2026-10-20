// In-process server test harness. Boots the REAL server (startServer from
// server/isomux-office.ts) against the temp STATE_ROOT the test
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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  startServer,
  type ServerHandle,
  type StartServerOpts,
} from "../isomux-office.ts";
import { STATE_ROOT } from "../config.ts";
import { OFFICE_DATABASE, officeAuditStore } from "../audit-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  createFakeAppSupervisor,
  type FakeAppSupervisor,
} from "./fake-app-supervisor.ts";
import { assertSafeToDelete, removeStateDir } from "./temp-state.ts";
import {
  sessionCookieName,
  buildPublicOrigin,
  acceptInvite,
  mintInvite,
  INVITE_TTL_MS,
  _testResetState,
  _testResetOwnerClaimedInThisProcess,
  _testSeedOwner,
} from "../auth.ts";
import { _testResetUsers, createMember } from "../users.ts";
import { _testResetTokens } from "../identity/tokens.ts";
import { _testResetSkillUsage } from "../skill-usage.ts";
import { _testResetAppMessageLimits } from "../app-message-limits.ts";
import { _testResetAppHostDomain } from "../app-domain.ts";
import { _testResetAppAuth } from "../app-auth.ts";
import { _resetSetupKeyForTests, setupKeyFile } from "../setup-key.ts";
import { _testResetApiTokens } from "../api-tokens.ts";
import { registerProductionCronjobManagerForModuleReads } from "../cronjob-manager.ts";
import type { UserRole } from "../../shared/types.ts";

export interface SeededIdentity {
  username: string;
  role: UserRole;
  // The raw session cookie value. Pass to connectWs/http.
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
  // The supervisor the server was booted with - so an apps test can assert what
  // was installed, script a systemd failure, or force an app's state.
  appSupervisor: FakeAppSupervisor;
  baseUrl: string;
  // Seed the office's first owner (real mint+accept). Returns the cookie value.
  seedOwner(displayName?: string): Promise<SeededIdentity>;
  // Seed a member user (requires an existing owner). Real mint+accept.
  seedMember(displayName: string): Promise<SeededIdentity>;
  // The setup key an unclaimed office keeps in its state dir, read from the
  // file the way the VPS installer reads it.
  setupKey(): string;
  // fetch() against the server with the right Origin and an optional cookie.
  http(
    path: string,
    init?: RequestInit & { rawSessionId?: string },
  ): Promise<Response>;
  // Open a real authenticated WebSocket (cookie + matching Origin).
  connectWs(
    rawSessionId: string,
    opts?: { cookieHeader?: string; headers?: Record<string, string> },
  ): Promise<TestSocket>;
  // COLD-RELOAD this server WITHOUT wiping STATE_ROOT: stops the current
  // instance and re-runs the real boot path against the on-disk state this run
  // persisted. Returns a FRESH TestServer (new port + handle); the old one is
  // dead. For persistence / boot-migration ORDERING tests - e.g. asserting the
  // 3b owner-access migration runs at boot against real persisted owners +
  // rooms. Test-support ONLY; see bootTestServer's header.
  restart(): Promise<TestServer>;
}

export interface StartTestServerOpts {
  // Inject a pre-configured FakeBackend (e.g. a custom onSend / auth-error
  // predicate). Default: a FakeBackend that auto-completes each turn on send.
  fakeBackend?: FakeBackend;
  // Inject a pre-configured fake app supervisor. Default: a fresh one. There is
  // deliberately no way to ask for the REAL supervisor here - see the field on
  // TestServer.
  appSupervisor?: FakeAppSupervisor;
  // Extra startServer opts merged over the harness defaults. Rarely needed.
  startServer?: Partial<StartServerOpts>;
}

// A fresh test office has no provider CLI account. Keep the real account
// manager and its wire shaping under test, but model that unavailable probe
// without starting provider subprocesses. This also keeps onboarding's backend
// login-text + terminal-command fallback branch deterministic across machines.
const unavailableAccountClient = () =>
  ({
    start: async () => {
      throw new Error("provider CLI unavailable in test harness");
    },
    read: async () => ({ connected: false }),
    close: async () => {},
  }) as never;

// Process-global single-instance guard (see file header).
let activeHarness = false;

// The office database's schema as a boot creates it, recorded once per
// process. A new office.sqlite costs six fsyncs, and one per test slowed the
// Postgres governance suites toward their test timeout (task 771856ca), so a
// wipe empties a database that still has this schema instead of deleting it.
let freshOfficeSchema: string | undefined;

function officeSchema(): string {
  const { db } = officeAuditStore();
  return JSON.stringify([
    db.query("PRAGMA user_version").get(),
    db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
      )
      .all(),
  ]);
}

// True when the office database had the fresh schema and is now empty;
// false, with nothing changed, otherwise.
function emptyOfficeDatabase(): boolean {
  if (
    freshOfficeSchema === undefined ||
    !existsSync(join(STATE_ROOT, OFFICE_DATABASE))
  )
    return false;
  try {
    if (officeSchema() !== freshOfficeSchema) return false;
    const { db } = officeAuditStore();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    db.transaction(() => {
      db.exec("PRAGMA defer_foreign_keys = ON");
      for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
    })();
    return true;
  } catch {
    return false;
  }
}

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
// reset, so a restart is a TRUE cold boot that re-reads every persisted file -
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
      if (emptyOfficeDatabase()) {
        const kept = ["", "-wal", "-shm"].map((end) => OFFICE_DATABASE + end);
        for (const entry of readdirSync(STATE_ROOT))
          if (!kept.includes(entry)) removeStateDir(join(STATE_ROOT, entry));
      } else {
        removeStateDir(STATE_ROOT);
        mkdirSync(STATE_ROOT, { recursive: true });
      }
      _testResetOwnerClaimedInThisProcess();
    }
    // Reset the module caches that lazy-load from STATE_ROOT - ALWAYS, even on a
    // no-wipe restart, so the re-boot re-reads the persisted files instead of
    // serving a stale in-memory cache from the prior instance.
    _testResetState();
    _testResetUsers();
    _testResetTokens();
    _testResetApiTokens();
    _testResetSkillUsage();
    // App-message rate limits live in memory and reset when isomux restarts, so
    // a boot - INCLUDING a no-wipe restart(), which models exactly that - has to
    // clear them. Skipping it on restart would make the harness carry a budget
    // across a restart the product says empties it.
    _testResetAppMessageLimits();
    // App hostnames are boot-frozen (bootPrelude re-freezes them on every
    // start), so this only matters between stop() and the next start - but a
    // stale domain sitting in the module while no server is up is exactly the
    // kind of thing a later test would trip over.
    _testResetAppHostDomain();
    // App sign-in codes and app sessions live in memory and die with the
    // office process, so a boot - INCLUDING a no-wipe restart(), which models
    // exactly that - starts with empty tables. Carrying them across would let
    // a test prove a cookie survives a restart when the product says it does
    // not.
    _testResetAppAuth();
    // The setup key and its wrong-key counts live in the office process too.
    _resetSetupKeyForTests();
    registerProductionCronjobManagerForModuleReads(null);

    const fakeBackend =
      opts.fakeBackend ??
      new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      });
    // ALWAYS a fake, and never optional: the real supervisor writes systemd
    // unit files and drives the box's own user manager, which the office
    // running on that box shares. See fake-app-supervisor.ts.
    const appSupervisor = opts.appSupervisor ?? createFakeAppSupervisor();

    const handle = await startServer({
      port: 0,
      resolveBackend: () => fakeBackend,
      discoverWelcomeOpenCodeModels: async () => [
        {
          id: "opencode/muse-spark-1.2-contributor-free",
          label: "Muse Spark",
          isFree: true,
          supportedEfforts: [],
        },
      ],
      // A Codex spawn with no model must never start the box's real codex
      // binary: discovery fails, so the static default applies. A test of the
      // discovered default passes its own list through opts.startServer.
      listCodexModels: async () => {
        throw new Error("test harness: no Codex model discovery");
      },
      appSupervisor,
      createCodexAccountClient: unavailableAccountClient,
      createClaudeAccountClient: unavailableAccountClient,
      skipSchedulers: true,
      skipBackups: true,
      skipAdminSocket: true,
      skipUpdateChecker: true,
      // No test sends a page to Discord: a test that saves a webhook passes
      // its own stub through opts.startServer.pagerFetch.
      pagerFetch: async () => {
        throw new Error("test harness: pager send without a pagerFetch stub");
      },
      // Nor does a Test button call a real service: a test that presses one
      // passes its own stub through opts.startServer.connectionTestFetch.
      connectionTestFetch: async () => {
        throw new Error(
          "test harness: connection test without a connectionTestFetch stub",
        );
      },
      quiet: true,
      awaitRestore: true,
      getBackupStatus: () => ({
        backupDir: `${STATE_ROOT}/test-backups`,
        retention: 7,
        lastBackupAt: null,
        lastBackupOk: null,
        lastBackupError: null,
        lastBackupFile: null,
        running: false,
      }),
      ...opts.startServer,
    });

    if (
      wipe &&
      freshOfficeSchema === undefined &&
      existsSync(join(STATE_ROOT, OFFICE_DATABASE))
    )
      freshOfficeSchema = officeSchema();

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
      const created = createMember(displayName, { role: "member" });
      if (!created.ok)
        throw new Error(`seedMember: create failed: ${created.error}`);
      const mint = await mintInvite({
        userId: created.user.id,
        createdBy: null,
        ttlMs: INVITE_TTL_MS,
      });
      if (!mint.ok) throw new Error(`seedMember: mint failed: ${mint.error}`);
      const acc = await acceptInvite(mint.rawToken, { userAgent: "test" });
      if (!acc.ok) throw new Error(`seedMember: accept failed: ${acc.error}`);
      return {
        username: acc.username,
        role: acc.role,
        rawSessionId: acc.rawSessionId,
      };
    }

    async function http(
      path: string,
      init: RequestInit & { rawSessionId?: string } = {},
    ): Promise<Response> {
      const { rawSessionId, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("Origin", buildPublicOrigin().origin);
      // Fetch's keep-alive pool can hand this request a socket that belonged
      // to an earlier test's server: every test binds port 0, ports recycle,
      // and a reused dead socket surfaces as ECONNRESET - seen repeatedly on
      // GitHub's slower runners, never locally. Close per request, and retry
      // idempotent methods once in case the pool still
      // wins the race.
      headers.set("Connection", "close");
      if (rawSessionId)
        headers.set("Cookie", `${sessionCookieName()}=${rawSessionId}`);
      const attempt = () => fetch(`${baseUrl}${path}`, { ...rest, headers });
      try {
        return await attempt();
      } catch (err) {
        const method = (rest.method ?? "GET").toUpperCase();
        const idempotent = ["GET", "HEAD", "OPTIONS"].includes(method);
        const code = (err as { code?: string })?.code;
        if (idempotent && code === "ECONNRESET") return attempt();
        throw err;
      }
    }

    async function connectWs(
      rawSessionId: string,
      opts?: { cookieHeader?: string; headers?: Record<string, string> },
    ): Promise<TestSocket> {
      // Bun's WebSocket client accepts a { headers } options object so the
      // upgrade carries the auth cookie + matching Origin. The DOM lib types
      // only the (url, protocols) overload, so cast through unknown; this is
      // runtime-correct under Bun.
      //
      // cookieHeader replaces the whole Cookie header, for tests that need to
      // send several session cookies at once (the __Host- dual-read matrix).
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        headers: {
          Cookie:
            opts?.cookieHeader ?? `${sessionCookieName()}=${rawSessionId}`,
          Origin: buildPublicOrigin().origin,
          ...opts?.headers,
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
        // life - which the production force-expire path does on session
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
      // persisted - exercising the real boot path (incl. boot migrations)
      // against real on-disk state. Returns the fresh TestServer.
      await stop();
      // The supervisor is carried across deliberately: systemd outlives the
      // isomux process, so a restart that forgot which apps were running would
      // model the opposite of the property apps are supposed to have.
      return bootTestServer({ ...opts, appSupervisor }, { wipe: false });
    }

    return {
      ...handle,
      stateRoot: STATE_ROOT,
      fakeBackend,
      appSupervisor,
      baseUrl,
      seedOwner,
      seedMember,
      setupKey: () => readFileSync(setupKeyFile(), "utf8").trim(),
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
