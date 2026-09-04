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

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { errMessage } from "../../../shared/errors.ts";
import { resolveCodexLauncherPath, withIsomuxCodexHome } from "./native-bin.ts";
import {
  ensureCodexSafetyHook,
  type CodexSafetyPreflightResult,
} from "./safety-hook-install.ts";

// Surfaced verbatim into chat by sendMessage's BackendNotConfiguredError
// handling when the bundled launcher can't be spawned. Since codex now ships
// as an isomux runtime dep, ENOENT here means the install is corrupt, not
// that the user forgot to install something.
const CODEX_LAUNCH_FAILED_MESSAGE = `Isomux's bundled Codex CLI failed to launch. Run \`bun install\` in the isomux checkout, then \`/clear\` this conversation to retry.`;

// Grace period between SIGTERM and the SIGKILL escalation when closing a codex
// subprocess group. Long enough for a healthy process to flush and exit, short
// enough that a hung (mid-turn) process is reclaimed promptly.
const CODEX_KILL_GRACE_MS = 2000;

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
}

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
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private stdoutBuffer = "";
  private closed = false;
  private closedReason: Error | null = null;
  private starting = false;
  // Guards the OS-process kill in close(), tracked separately from `closed`
  // (which the error/exit handlers set while the process may still be alive).
  private killed = false;
  // Pending SIGTERM->SIGKILL escalation timer; cleared when the child exits.
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitInfo: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private initialized = false;

  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stderrHandlers = new Set<(chunk: string) => void>();
  private exitHandlers = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  private closeHandlers = new Set<() => void>();

  constructor(private readonly opts: JsonRpcLiteClientOptions = {}) {}

  async start(): Promise<CodexSafetyPreflightResult> {
    if (this.child || this.starting) {
      throw new Error("JsonRpcLiteClient.start() called twice");
    }
    if (this.closed) {
      throw new Error("JsonRpcLiteClient is closed");
    }
    this.starting = true;
    const effectiveEnv = withIsomuxCodexHome(this.opts.env);
    let safety: CodexSafetyPreflightResult = {
      warning: null,
      hookIdentity: null,
    };
    if (!this.opts.skipSafetyPreflightForTestProbe) {
      safety = await ensureCodexSafetyHook(effectiveEnv.CODEX_HOME!);
    }
    const codexArgs = this.opts.args ?? ["app-server", "--listen", "stdio://"];
    let bin: string;
    let spawnArgs: string[];
    if (this.opts.codexBin) {
      bin = this.opts.codexBin;
      spawnArgs = codexArgs;
    } else {
      // Default: bundled launcher under process.execPath (Bun runs the JS
      // launcher fine - we don't depend on `node` being on PATH). Resolution
      // throws here are translated to a chat-actionable hint via the catch
      // in CodexSession.bootstrap.
      const launcher = resolveCodexLauncherPath();
      bin = process.execPath;
      spawnArgs = [launcher, ...codexArgs];
    }
    // Apply the isomux CODEX_HOME default here (not at every adapter
    // callsite) so model/list, fork, read, one-shot, and the session bootstrap
    // all spawn with the same effective env. withIsomuxCodexHome honors a
    // caller-set CODEX_HOME verbatim (per-user envFile billing isolation, see
    // server/backends/codex/native-bin.ts).
    try {
      this.child = spawn(bin, spawnArgs, {
        cwd: this.opts.cwd,
        env: effectiveEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Make the launcher its own process-group leader so close() can signal
        // the whole group (`process.kill(-pid)`) and reap the native codex
        // grandchild too - the launcher does not forward signals, so without this
        // a SIGTERM/SIGKILL to the launcher alone leaks the native child. The
        // native does not setsid away, so it stays in this group. Safe because
        // the group is the launcher's own, never isomux's. Note: detached only
        // changes the POSIX process group, not cgroup membership, so a systemd
        // service restart still reaps the subtree via the cgroup.
        detached: true,
      });
    } finally {
      this.starting = false;
    }

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      for (const h of this.stderrHandlers) {
        try {
          h(chunk);
        } catch {}
      }
    });
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure. Translate ENOENT to a user-actionable reinstall hint
      // (bundled binary missing or corrupt) rather than just the raw errno;
      // every other failure falls through to the underlying message. Mark
      // the client closed so any subsequent request short-circuits on the
      // `this.closed` guard in request() instead of writing to a dead process.
      this.closed = true;
      if (err.code === "ENOENT") {
        this.closedReason = new Error(CODEX_LAUNCH_FAILED_MESSAGE);
        this.failAllPending(this.closedReason);
      } else {
        this.closedReason = new Error(`codex subprocess error: ${err.message}`);
        this.failAllPending(this.closedReason);
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.closed = true;
      this.closedReason = new Error(
        `codex subprocess exited${code != null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}`,
      );
      // The process is gone; cancel any pending SIGKILL escalation so a dangling
      // timer can't fire against a recycled pid.
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.failAllPending(this.closedReason);
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
    const response = await this.request<InitializeResponse>(
      "initialize",
      params,
    );
    this.initialized = true;
    this.notify("initialized", {});
    return response;
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
      const child = this.child;
      if (child && child.pid !== undefined && !child.killed) {
        try {
          child.stdin.end();
        } catch {}
        // The launcher is its own group leader (spawned detached), so its pid
        // is also its process-group id. Signal the negative pid to hit the
        // whole group - launcher AND the native codex grandchild - without
        // depending on the launcher forwarding signals. SIGTERM first, then
        // escalate to SIGKILL if the group hasn't exited within the grace
        // window (the fallback the old comment promised but never implemented).
        const pgid = child.pid;
        try {
          process.kill(-pgid, "SIGTERM");
        } catch {}
        const timer = setTimeout(() => {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {}
        }, CODEX_KILL_GRACE_MS);
        // Don't let the escalation timer keep the event loop alive on its own;
        // the exit handler clears it once the process is reaped.
        //
        // Edge: because it's unref'd, a graceful IN-PROCESS server shutdown that
        // exits within the grace window would skip the SIGKILL for a child that
        // also ignores SIGTERM. That's covered in production by systemd's
        // KillMode=control-group, which cgroup-kills the whole subtree on
        // service stop/restart regardless of POSIX process group. The unref is
        // the right tradeoff (don't pin the loop for 2s on every close); the
        // cgroup is the backstop for the in-process-exit corner.
        timer.unref?.();
        this.killTimer = timer;
      }
    }
    this.closed = true;
    this.failAllPending("client closed");
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
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }
}
