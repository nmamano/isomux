// JSON-RPC lite client for the Codex App Server.
//
// "JSON-RPC lite" (per the OpenAI Codex blog footnote): keeps the
// request/response/notification shape but omits the `"jsonrpc": "2.0"` header
// and is framed as JSONL over stdio. We write the framing ourselves; an
// off-the-shelf JSON-RPC library would reject these messages.
//
// Transport: spawn `codex app-server --listen stdio://`. stdin/stdout carry
// the JSON-RPC lite frames; stderr is opaque process output and routes to a
// caller-supplied handler (Isomux pipes it to the agent log).
//
// Wire shapes (post-handshake):
//   request:        { id, method, params }            - client → server
//   notification:   { method, params }                - either direction (no id)
//   response:       { id, result } or { id, error }   - either direction
//   server-request: { id, method, params }            - server → client; client
//                                                       must respond with same id
//
// Discrimination at parse time:
//   - has both `method` and `id`         → request (server-initiated)
//   - has `method` but no `id`           → notification
//   - has `id` and (`result` or `error`) → response to one of our requests
//
// The client is single-thread-aware: subscribers filter incoming notifications
// by threadId (filtering happens at subscription, not here). A future shared-
// subprocess deployment can swap this client out without callsite changes.
//
// Per-session deployment is the v1 default (symmetric with Claude, crash
// isolation, simpler auth/request-id scoping). The transport layer is
// designed to support sharing later without breaking the contract.

import type { OfficeAuth, OfficeCodexTokens } from "../../office-login-sync.ts";
import { resolve } from "path";
import { errMessage } from "../../../shared/errors.ts";
import type { AgentChild } from "../../agent-host.ts";
import { runAtServerStop, serverStopping } from "../../server-stop.ts";
import { hostForEnv } from "../../member-hosts.ts";
import {
  codexEnvApiKeyWins,
  ISOMUX_CODEX_HOME,
  withIsomuxCodexHome,
} from "./native-bin.ts";
import {
  ensureCodexSafetyHook,
  type CodexSafetyPreflightResult,
} from "./safety-hook-install.ts";

// Surfaced verbatim into chat by sendMessage's BackendNotConfiguredError
// handling when the bundled launcher can't be spawned. Since codex now ships
// as an isomux runtime dep, ENOENT here means the install is corrupt, not
// that the user forgot to install something.
const CODEX_LAUNCH_FAILED_MESSAGE = `Isomux's bundled Codex CLI failed to launch. Run \`bun install\` in the Isomux checkout, then \`/clear\` this conversation to retry.`;

// Grace period between SIGTERM and the SIGKILL escalation when closing a codex
// subprocess group. Long enough for a healthy process to flush and exit, short
// enough that a hung (mid-turn) process is reclaimed promptly.
export const CODEX_KILL_GRACE_MS = 2000;

// How often the end of a group is checked during its grace.
const GROUP_POLL_MS = 25;
// After the SIGKILL, how long the end of a group is waited for at most.
const AFTER_KILL_WAIT_MS = 500;

// Every client whose App Server process group may still hold a live process:
// in from its spawn, out once the group is empty or has had its SIGKILL. The
// office's stop ends them all (task 36e2ae21): each group is its own (the
// agent host starts it detached), so a stop that is not a systemd unit's
// cgroup kill (Ctrl-C, another supervisor, a scratch office in an agent
// shell) signals none of them, and a native codex outlives the office.
const liveClients = new Set<JsonRpcLiteClient>();

/**
 * Ends every App Server process group this office started that can still
 * hold a live process: the office's stop hook (task 36e2ae21). Resolves once
 * each group is empty or has had its SIGKILL. Never throws.
 */
export async function stopAllCodexClients(): Promise<void> {
  await Promise.all(
    [...liveClients].map((client) => client.endGroup().catch(() => {})),
  );
}

/** How many clients still have a process group that may hold a live process. */
export function liveCodexClientCount(): number {
  return liveClients.size;
}

runAtServerStop(stopAllCodexClients);

// False only when the group is known to be empty. A runner's pid belongs to
// another OS user (kill reports EPERM), so there it is never known.
function localGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Two App Servers that start at the same time on a fresh CODEX_HOME race to
// create its state database, and one exits 1 before it answers initialize
// (Codex 0.164-0.167; task 6e4e2012). So one launch opens a cold home and the
// others wait for its initialize answer, at most this long, then start
// anyway: a hung opener must not block every session on its home. Absent
// from the map = cold. Per process: after a restart a home is opened once
// more, which costs one launch one initialize.
const DEFAULT_LAUNCH_GATE_WAIT_MS = 10_000;
let launchGateWaitMs = DEFAULT_LAUNCH_GATE_WAIT_MS;
type LaunchGate =
  { kind: "opening"; settled: Promise<void> } | { kind: "ready" };
const launchGates = new Map<string, LaunchGate>();

// Tests shorten the wait; null restores the default.
export function setCodexLaunchGateWaitMsForTests(ms: number | null): void {
  launchGateWaitMs = ms ?? DEFAULT_LAUNCH_GATE_WAIT_MS;
}

import type { InitializeParams } from "./_generated/InitializeParams.ts";
import type { InitializeResponse } from "./_generated/InitializeResponse.ts";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC error codes; we only emit the "method not found" /
// "internal error" ones when responding to unhandled server requests.
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface JsonRpcLiteClientOptions {
  cwd?: string;
  env?: { [key: string]: string | undefined };
  // Override the spawn binary for tests. Defaults to spawning the bundled
  // @openai/codex launcher under process.execPath (Bun). Tests can point
  // this at any executable and bypass the launcher resolution entirely.
  codexBin?: string;
  // Override the args. Defaults to ["app-server", "--listen", "stdio://"]
  // (the launcher path is prepended automatically when codexBin is not set).
  args?: string[];
  // Test/probe-only escape hatch for fixtures that intentionally install
  // malformed, missing, or untrusted hooks. Production callers must never set
  // this; the default keeps every new spawn site protected by construction.
  skipSafetyPreflightForTestProbe?: boolean;
  // Codex 0.160 reads no API key from its env (task 5e0917f3). With
  // OPENAI_API_KEY in the env and no stored sign-in in CODEX_HOME
  // (codexEnvApiKeyWins), the app-server keeps its logins in memory only and
  // initialize() signs it in with the key, which never lands in a shared
  // CODEX_HOME. A stored sign-in wins (task 23c1992a). Clients that must
  // read or write the stored sign-in (the sign-in card, the office plan
  // probe) pass false.
  envApiKeyLogin?: boolean;
  // The home is a member office folder (server/office-login-sync.ts): the
  // app-server keeps its sign-in in memory, initialize() logs it in with
  // the office's access token, and a 401's refresh request is answered from
  // here. When the office has no ChatGPT sign-in, the env OPENAI_API_KEY
  // logs in instead, if there is one; else Codex runs signed out.
  officeAuth?: OfficeAuth;
}

// The code of OfficeAuth.refresh's refusal when the office signed in to
// another ChatGPT account: the app-server that holds the old one ends, and
// the next turn starts a new one on the new account.
export const OFFICE_ACCOUNT_CHANGED = "office_account_changed";

export type NotificationHandler = (notification: JsonRpcNotification) => void;

// Server-request handler. Return PASS to delegate to the next handler in
// registration order. Returning a value (or throwing) commits this handler to
// providing the response. If no handler claims a server request, the client
// auto-responds with method-not-found.
export const PASS: unique symbol = Symbol("PASS");
// Returning the PASS symbol (which is `unknown`-typed) declines the request
// and lets the next handler in registration order respond.
export type ServerRequestHandler = (
  request: JsonRpcRequest,
) => Promise<unknown>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class JsonRpcLiteClient {
  private child: AgentChild | null = null;
  private nextRequestId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private stdoutBuffer = "";
  private closed = false;
  private closedReason: Error | null = null;
  private starting = false;
  // Guards the OS-process kill in close(), tracked separately from `closed`
  // (which the error/exit handlers set while the process may still be alive).
  private killed = false;
  // The end of this client's process group, once begun (endGroup).
  private groupEnd: Promise<void> | null = null;
  // Set by start(): the App Server runs under a runner, as another OS user.
  private onRunner = false;
  private exitInfo: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private initialized = false;
  // The CODEX_HOME of this launch, the key of launchGates; set by start().
  private launchHome: string | null = null;
  // Set while this client is the launch that opens a cold home: every way
  // the launch settles calls it once.
  private releaseLaunchGate: (() => void) | null = null;
  // Set while start() waits for another launch to open the home.
  private wakeLaunchWaiter: (() => void) | null = null;
  // The key initialize() signs in with; set by start().
  private envApiKey: string | null = null;
  // The office access token this app-server holds (officeAuth).
  private officeAccess: string | null = null;

  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stderrHandlers = new Set<(chunk: string) => void>();
  private exitHandlers = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  private closeHandlers = new Set<() => void>();

  constructor(private readonly opts: JsonRpcLiteClientOptions = {}) {}

  // isolate: run the App Server in its own PID namespace (danger-full-access
  // sessions only; server/process-isolation.ts).
  async start(
    opts: { isolate?: boolean } = {},
  ): Promise<CodexSafetyPreflightResult> {
    if (this.child || this.starting) {
      throw new Error("JsonRpcLiteClient.start() called twice");
    }
    if (this.closed) {
      throw new Error("JsonRpcLiteClient is closed");
    }
    this.starting = true;
    // An isolated member's env names its member: the App Server starts on
    // that member's host.
    const host = hostForEnv(this.opts.env);
    const effectiveEnv = withIsomuxCodexHome(this.opts.env);
    // In split mode the office codex-home is in agent space; the agent user
    // creates it (withIsomuxCodexHome does it in process otherwise).
    if (host.kind === "runner" && effectiveEnv.CODEX_HOME === ISOMUX_CODEX_HOME)
      await host.fs.mkdir(ISOMUX_CODEX_HOME, 0o700).catch(() => {});
    // An isolated member's Codex home (in their agent space): their runner
    // makes it, as the member.
    else if (host.member !== undefined && effectiveEnv.CODEX_HOME)
      await host.fs.mkdir(effectiveEnv.CODEX_HOME, 0o700).catch(() => {});
    let safety: CodexSafetyPreflightResult = {
      warning: null,
      hookIdentity: null,
    };
    if (!this.opts.skipSafetyPreflightForTestProbe) {
      safety = await ensureCodexSafetyHook(effectiveEnv.CODEX_HOME!, host);
    }
    if (safety.refusal) {
      this.starting = false;
      throw new Error(safety.refusal);
    }
    // Analytics starts with the App Server, before thread config overrides.
    // A launch override also covers per-user CODEX_HOME without file writes.
    const baseArgs = this.opts.args ?? ["app-server", "--listen", "stdio://"];
    const officeAuth =
      this.opts.officeAuth !== undefined && baseArgs[0] === "app-server";
    this.envApiKey =
      this.opts.envApiKeyLogin !== false &&
      baseArgs[0] === "app-server" &&
      (officeAuth
        ? !!effectiveEnv.OPENAI_API_KEY
        : await codexEnvApiKeyWins(effectiveEnv))
        ? effectiveEnv.OPENAI_API_KEY!
        : null;
    const codexArgs = [
      ...baseArgs,
      "-c",
      "analytics.enabled=false",
      ...(this.envApiKey || officeAuth
        ? ["-c", 'cli_auth_credentials_store="ephemeral"']
        : []),
    ];
    let bin: string;
    let spawnArgs: string[];
    if (this.opts.codexBin) {
      bin = this.opts.codexBin;
      spawnArgs = codexArgs;
    } else {
      // Default: bundled launcher under the host's Bun (Bun runs the JS
      // launcher fine - we don't depend on `node` being on PATH). Resolution
      // throws here are translated to a chat-actionable hint via the catch
      // in CodexSession.bootstrap.
      const launcher = host.codexLauncher();
      bin = host.bunPath();
      spawnArgs = [launcher, ...codexArgs];
    }
    // Apply the isomux CODEX_HOME default here (not at every adapter
    // callsite) so model/list, fork, read, one-shot, and the session bootstrap
    // all spawn with the same effective env. withIsomuxCodexHome honors a
    // caller-set CODEX_HOME verbatim (per-user managed variables for billing isolation, see
    // server/backends/codex/native-bin.ts).

    // One launch opens a cold home (launchGates, top of this file).
    if (effectiveEnv.CODEX_HOME) {
      this.launchHome = resolve(effectiveEnv.CODEX_HOME);
      await this.passLaunchGate(this.launchHome);
    }
    // A close() during the awaits above found no child to kill, and the
    // office's stop hook (stopAllCodexClients) may have run already: spawning
    // now would leave an App Server that nothing stops. Checked in the same
    // tick as the spawn, so no stop can come between.
    if (this.killed || serverStopping()) {
      this.starting = false;
      this.releaseLaunchGate?.();
      throw new Error("JsonRpcLiteClient is closed");
    }
    let child: AgentChild;
    try {
      // The agent host starts the launcher as its own process-group leader, so
      // close() can signal the whole group and reap the native codex
      // grandchild too - the launcher does not forward signals, so without
      // this a SIGTERM/SIGKILL to the launcher alone leaks the native child.
      // The native does not setsid away, so it stays in this group. Safe
      // because the group is the launcher's own, never isomux's. Because the
      // group is not the office's, nothing ends it when the office stops but
      // the stop hook above (stopAllCodexClients).
      child = this.child = host.spawnChild([bin, ...spawnArgs], {
        cwd: this.opts.cwd,
        env: effectiveEnv,
        stderr: "pipe",
        ...(opts.isolate ? { isolate: true } : {}),
      });
      this.onRunner = host.kind === "runner";
      liveClients.add(this);
    } catch (err) {
      this.releaseLaunchGate?.();
      throw err;
    } finally {
      this.starting = false;
    }

    child.stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: string) => {
      for (const h of this.stderrHandlers) {
        try {
          h(chunk);
        } catch {}
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure. Translate ENOENT to a user-actionable reinstall hint
      // (bundled binary missing or corrupt) rather than just the raw errno;
      // every other failure falls through to the underlying message. Mark
      // the client closed so any subsequent request short-circuits on the
      // `this.closed` guard in request() instead of writing to a dead process.
      this.closed = true;
      this.releaseLaunchGate?.();
      if (err.code === "ENOENT") {
        this.closedReason = new Error(CODEX_LAUNCH_FAILED_MESSAGE);
        this.failAllPending(this.closedReason);
      } else {
        this.closedReason = new Error(`codex subprocess error: ${err.message}`);
        this.failAllPending(this.closedReason);
      }
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitInfo = { code, signal };
      this.closed = true;
      this.releaseLaunchGate?.();
      this.closedReason = new Error(
        `codex subprocess exited${code != null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}`,
      );
      this.failAllPending(this.closedReason);
      // A launcher that exits with no close() (a crash, out of memory) can
      // leave its native codex running in the group: end the group now.
      if (!this.killed) {
        this.killed = true;
        void this.endGroup();
      }
      for (const h of this.exitHandlers) {
        try {
          h(code, signal);
        } catch {}
      }
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch {}
      }
    });
    // A runner reports the pid after the start; wait for it (or the start
    // error) so write() can tell a running child from a failed launch.
    if (child.pid === undefined && host.kind === "runner")
      await new Promise<void>((resolve) => {
        child.once("spawn", resolve);
        child.once("error", () => resolve());
      });
    return safety;
  }

  // Send the JSON-RPC `initialize` handshake. Caller is responsible for
  // setting `experimentalApi: true` in params.capabilities if they want the
  // experimental surface (we generated schemas with --experimental, so most
  // callers will).
  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    if (this.initialized) {
      throw new Error("initialize() called twice on the same client");
    }
    let response: InitializeResponse;
    try {
      response = await this.request<InitializeResponse>("initialize", params);
    } catch (err) {
      this.releaseLaunchGate?.();
      throw err;
    }
    // An answer means Codex created the home's state database. Ready before
    // the release, so a release cannot turn the home cold again.
    if (this.launchHome) launchGates.set(this.launchHome, { kind: "ready" });
    this.releaseLaunchGate?.();
    this.initialized = true;
    this.notify("initialized", {});
    if (this.opts.officeAuth && (await this.officeLogin())) return response;
    const apiKey = this.envApiKey;
    if (apiKey) {
      // Codex refuses an API-key login only by its own config (a bad key
      // fails at the first turn instead). Its reason must not echo the key,
      // so the new error carries no cause.
      const refusal = await this.request("account/login/start", {
        type: "apiKey",
        apiKey,
      }).then(
        () => null,
        (err: unknown) =>
          errMessage(err).replaceAll(apiKey, "[OPENAI_API_KEY]"),
      );
      if (refusal !== null)
        throw new Error(
          `Codex refused to sign in with OPENAI_API_KEY: ${refusal}`,
        );
    }
    return response;
  }

  // The office ChatGPT login (officeAuth). False when the office has no
  // ChatGPT sign-in: an env key logs in instead, or, with none, the
  // app-server starts signed out and Codex refuses the turn, which the
  // sign-in path handles as for any member on the office sign-in.
  private async officeLogin(): Promise<boolean> {
    let tokens: OfficeCodexTokens;
    try {
      tokens = await this.opts.officeAuth!.tokens();
    } catch {
      return false;
    }
    await this.request("account/login/start", {
      type: "chatgptAuthTokens",
      ...tokens,
    });
    this.officeAccess = tokens.accessToken;
    return true;
  }

  // Codex was refused the office token: the office's newer one.
  private async officeRefresh(params: unknown): Promise<OfficeCodexTokens> {
    const previous =
      params && typeof params === "object"
        ? (params as { previousAccountId?: unknown }).previousAccountId
        : undefined;
    const tokens = await this.opts.officeAuth!.refresh(
      this.officeAccess ?? "",
      typeof previous === "string" ? previous : null,
    );
    this.officeAccess = tokens.accessToken;
    return tokens;
  }

  async close(): Promise<void> {
    // Guard the kill on `killed`, NOT `closed`: the error/exit handlers set
    // `closed = true` while the OS process may still be alive (e.g. a spawn
    // `error` event on a process that then hangs), and an early
    // `if (this.closed) return` here would skip the kill and leak the launcher
    // plus its native codex grandchild. Track the kill separately so it runs
    // exactly once regardless of teardown races.
    if (!this.killed) {
      this.killed = true;
      void this.endGroup();
    }
    this.closed = true;
    this.wakeLaunchWaiter?.();
    this.releaseLaunchGate?.();
    this.failAllPending("client closed");
  }

  // Returns when this launch may spawn: the home is ready, this client opens
  // it, the wait ran out, or close() was called (start() then throws).
  private async passLaunchGate(home: string): Promise<void> {
    const deadline = Date.now() + launchGateWaitMs;
    for (;;) {
      if (this.killed) return;
      const gate = launchGates.get(home);
      if (gate?.kind === "ready") return;
      if (!gate) {
        let settle!: () => void;
        const opening: LaunchGate = {
          kind: "opening",
          settled: new Promise<void>((done) => (settle = done)),
        };
        launchGates.set(home, opening);
        this.releaseLaunchGate = () => {
          this.releaseLaunchGate = null;
          if (launchGates.get(home) === opening) launchGates.delete(home);
          settle();
        };
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) return;
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, left);
        const done = () => {
          clearTimeout(timer);
          wake();
        };
        this.wakeLaunchWaiter = done;
        void gate.settled.then(done);
      });
      this.wakeLaunchWaiter = null;
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed || !this.child) {
      throw (
        this.closedReason ??
        new Error(`cannot send ${method}: client is closed`)
      );
    }
    const id = this.nextRequestId++;
    const frame: JsonRpcRequest = {
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
    try {
      this.write(frame);
    } catch (err) {
      // write() can throw if stdin is dead (subprocess never started, e.g.
      // posix_spawn ENOENT). Drop the pending so a later child.on('error')
      // doesn't reject an orphaned promise - that rejection has no awaiter
      // (request()'s own catch already surfaced the write error) and would
      // crash the process as an unhandled rejection.
      this.pending.delete(id);
      throw err;
    }
    return promise;
  }

  // Never throws: write errors are dropped to match JSON-RPC notification
  // semantics.
  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    const frame: JsonRpcNotification = {
      method,
      ...(params !== undefined ? { params } : {}),
    };
    try {
      this.write(frame);
    } catch {}
  }

  // Send a response to a server-initiated request. Most callers won't use
  // this directly - handler return values from onServerRequest are auto-
  // packaged into responses. Provided for handlers that need to deferred-
  // respond after the handler returns.
  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed || !this.child) return;
    const frame: JsonRpcSuccessResponse = { id, result };
    try {
      this.write(frame);
    } catch {}
  }

  respondWithError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (this.closed || !this.child) return;
    const frame: JsonRpcErrorResponse = {
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    try {
      this.write(frame);
    } catch {}
  }

  // Subscribe to incoming notifications. Returns an unsubscribe function.
  // Subscribers receive every notification; filter by params.threadId (or
  // other discriminators) downstream.
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  // Register a handler for server-initiated requests. Handlers are tried in
  // registration order; the first to return a non-PASS value (or throw)
  // commits to providing the response. If all handlers PASS, the client
  // responds method-not-found.
  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(handler);
    return () => {
      const i = this.serverRequestHandlers.indexOf(handler);
      if (i >= 0) this.serverRequestHandlers.splice(i, 1);
    };
  }

  onStderr(handler: (chunk: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => {
      this.stderrHandlers.delete(handler);
    };
  }

  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  private write(frame: unknown): void {
    if (!this.child) throw new Error("client not started");
    const line = JSON.stringify(frame) + "\n";
    // child.pid is undefined when spawn() failed synchronously (e.g. ENOENT
    // on a corrupt bundled launcher). Translating here wins the race against
    // the async child.on('error') ENOENT handler so the user-visible chat
    // error is the actionable reinstall hint, not the technical
    // "stdin is not writable" message that fires when the dead child's
    // stdin stream is already closed.
    if (this.child.pid === undefined) {
      throw new Error(CODEX_LAUNCH_FAILED_MESSAGE);
    }
    if (!this.child.stdin.writable) {
      throw new Error("codex stdin is not writable");
    }
    this.child.stdin.write(line);
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.dispatch(trimmed);
    }
  }

  private dispatch(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (err) {
      for (const h of this.stderrHandlers) {
        try {
          h(
            `[codex client] JSON parse error: ${errMessage(err)}\nframe: ${line.slice(0, 200)}\n`,
          );
        } catch {}
      }
      return;
    }
    if (frame == null || typeof frame !== "object") return;
    const f = frame as {
      id?: JsonRpcId;
      method?: string;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };

    const hasId = "id" in f && f.id != null;
    const hasMethod = "method" in f && typeof f.method === "string";

    // Server-initiated request - must respond with same id.
    if (hasMethod && hasId) {
      void this.handleServerRequest(f as JsonRpcRequest);
      return;
    }
    if (hasMethod) {
      const notification = f as JsonRpcNotification;
      for (const h of this.notificationHandlers) {
        try {
          h(notification);
        } catch (err) {
          for (const sh of this.stderrHandlers) {
            try {
              sh(
                `[codex client] notification handler error: ${errMessage(err)}\n`,
              );
            } catch {}
          }
        }
      }
      return;
    }
    if (hasId) {
      const id = f.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) {
        for (const h of this.stderrHandlers) {
          try {
            h(`[codex client] response for unknown request id ${String(id)}\n`);
          } catch {}
        }
        return;
      }
      this.pending.delete(id);
      if (f.error) {
        const err = f.error;
        pending.reject(
          Object.assign(
            new Error(
              `${err.message ?? "JSON-RPC error"} (code ${err.code ?? "?"})`,
            ),
            { code: err.code, data: err.data },
          ),
        );
      } else {
        pending.resolve("result" in f ? f.result : undefined);
      }
      return;
    }
    for (const h of this.stderrHandlers) {
      try {
        h(`[codex client] unrecognized frame: ${line.slice(0, 200)}\n`);
      } catch {}
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (
      this.officeAccess !== null &&
      request.method === "account/chatgptAuthTokens/refresh"
    ) {
      try {
        this.respond(request.id, await this.officeRefresh(request.params));
      } catch (err) {
        this.respondWithError(
          request.id,
          JSONRPC_INTERNAL_ERROR,
          errMessage(err, "the office Codex sign-in did not renew"),
        );
        // Never a thread on another account mid-turn: this app-server ends,
        // and the next turn starts one that logs in to the new account.
        if ((err as { code?: unknown }).code === OFFICE_ACCOUNT_CHANGED)
          void this.close().catch(() => {});
      }
      return;
    }
    for (const handler of [...this.serverRequestHandlers]) {
      try {
        const result = await handler(request);
        if (result === PASS) continue;
        this.respond(request.id, result);
        return;
      } catch (err) {
        this.respondWithError(
          request.id,
          JSONRPC_INTERNAL_ERROR,
          errMessage(err, "handler threw"),
        );
        return;
      }
    }
    this.respondWithError(
      request.id,
      JSONRPC_METHOD_NOT_FOUND,
      `No client handler for method "${request.method}"`,
    );
  }

  private failAllPending(reason: string | Error): void {
    const err = typeof reason === "string" ? new Error(reason) : reason;
    for (const [, pending] of this.pending) {
      try {
        pending.reject(err);
      } catch {}
    }
    this.pending.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
  isInitialized(): boolean {
    return this.initialized;
  }
  pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * End this client's process group: SIGTERM, then SIGKILL when the group
   * is not empty after CODEX_KILL_GRACE_MS. Runs once; a later call joins it.
   * Resolves once the group is empty or has had its SIGKILL, and the client
   * then leaves the registry (stopAllCodexClients). Never rejects.
   */
  endGroup(): Promise<void> {
    this.groupEnd ??= this.runGroupEnd().finally(() =>
      liveClients.delete(this),
    );
    return this.groupEnd;
  }

  private async runGroupEnd(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // The group is gone only when it is known to be empty: the launcher's
    // exit says nothing about the native codex, which can still be in (or
    // stuck in) its own SIGTERM shutdown, writing its state.
    const groupGone = () =>
      !this.onRunner &&
      (child.pid === undefined || !localGroupAlive(child.pid));
    if (groupGone()) return;
    try {
      child.stdin.end();
    } catch {}
    // The launcher leads its own process group, so signalGroup hits the
    // whole group - launcher AND the native codex grandchild - without
    // depending on the launcher forwarding signals.
    child.signalGroup("SIGTERM");
    const deadline = Date.now() + CODEX_KILL_GRACE_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.min(GROUP_POLL_MS, deadline - Date.now()));
      if (groupGone()) return;
    }
    // Once the group is empty, a new group taking the same number within the
    // grace is the residual risk the agent runner accepts too
    // (agent-runner/runner.ts stopGroup); on a runner, it sends this SIGKILL.
    child.signalGroup("SIGKILL");
    // A killed group empties once its launcher is reaped: wait for that, so
    // a caller that resolves after this finds the group gone.
    const killDeadline = Date.now() + AFTER_KILL_WAIT_MS;
    while (!this.onRunner && !groupGone() && Date.now() < killDeadline)
      await Bun.sleep(GROUP_POLL_MS);
  }
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }
}
