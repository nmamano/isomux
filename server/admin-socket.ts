import { recordAudit } from "./audit-store.ts";
// Unix-domain admin socket at ADMIN_SOCKET_PATH (<state root>/admin.sock by
// default). It answers POST /admin/owner-login with a 15-minute owner sign-in
// URL. Its callers run as root: install.sh claim_owner, the control plane's
// mint-invite.sh, and an operator's `sudo curl --unix-socket ...`.
//
// The socket checks the connecting process, not only the file mode. Every
// agent, terminal panel and app runs as the server's OS user, so the socket
// refuses that uid and answers only uid 0 or the uid in ISOMUX_RECOVERY_UID
// (the EKS recovery container, deploy/kubernetes). Design:
// internal-docs/owner-login-recovery-design.md (task 636901c1).
//
// Bun.serve exposes no peer data, so this is a Bun.listen server that reads
// the peer uid when it accepts a connection and parses the one HTTP request
// itself; the curl callers do not change.

import { chmodSync, existsSync, statSync, unlinkSync } from "fs";
import { ADMIN_SOCKET_PATH } from "./config.ts";
import {
  buildPublicOrigin,
  evictSessionsForUserId,
  INVITE_TTL_MS,
  mintInvite,
  revokeInvitesForUser,
} from "./auth.ts";
import { listApiTokens } from "./api-tokens.ts";
import { getUserByName, hasOwner } from "./users.ts";
import { activeSetupKeySource, setupKeyFile } from "./setup-key.ts";
import {
  handleMemberUserAdmin,
  MEMBER_USER_PATH_PREFIX,
} from "./member-user-admin.ts";
import {
  httpResponse,
  parseHttpRequest,
  readPeerCredentials,
  socketFileDescriptor,
  type ParsedRequest,
} from "./unix-socket-server.ts";

// 15 minutes: shell access + immediate hand-off to a browser. Tight enough
// that a forgotten URL on a shared screen expires quickly, loose enough to
// cover device-switching friction (open the URL on a phone after SSH'ing
// from a laptop, etc.).
const OWNER_LOGIN_TTL_MS = 15 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;

// The answer of the office's send for POST /admin/message: the agent found
// by id or exact name, the message sent as from its current manager.
export type AdminMessageResult =
  | { ok: true; agentId: string }
  | { ok: false; status: number; code: string; error: string };

// The device of a message sent through the socket, shown in the chat and to
// the agent after the manager's name. Not a replies-only device: the text is
// the manager's.
export const ADMIN_SOCKET_DEVICE = "admin socket";

// What the operator verbs need from the running office (isomux-office.ts
// builds it), so this module imports no agent manager.
export interface AdminSocketDeps {
  // Find the agent (id, or its exact name: names are unique) and send `text`
  // as from its current manager, with the manager's pack limits, never as an
  // answer to a pending prompt.
  sendMessage(agent: string, text: string): Promise<AdminMessageResult>;
  // The invites list changed (a sign-in link minted, links revoked).
  invitesChanged(): void;
}

export interface AdminSocketOptions {
  socketPath?: string;
  serverUid?: number;
  recoveryUidSetting?: string;
  readPeerUid?: (fd: number) => number | null;
  deps?: AdminSocketDeps;
}

interface ConnectionData {
  peerUid: number | null;
  buffer: Buffer;
  handled: boolean;
}

// The peer uids the socket answers: root and ISOMUX_RECOVERY_UID, never the
// server's own uid.
export function resolveAllowedPeerUids(
  serverUid: number,
  recoveryUidSetting: string | undefined,
): Set<number> {
  const allowed = new Set<number>([0]);
  const setting = recoveryUidSetting?.trim();
  if (setting) {
    const uid = /^\d+$/.test(setting) ? Number(setting) : NaN;
    if (!Number.isSafeInteger(uid)) {
      console.error(
        `[admin-socket] ISOMUX_RECOVERY_UID=${JSON.stringify(setting)} is not a uid; the setting is ignored.`,
      );
    } else if (uid === serverUid) {
      console.error(
        `[admin-socket] ISOMUX_RECOVERY_UID=${uid} is the server's own uid, which every agent shares; the setting is ignored.`,
      );
    } else {
      allowed.add(uid);
    }
  }
  if (allowed.delete(serverUid)) {
    console.error(
      "[admin-socket] the server runs as root, which every agent shares, so the admin socket refuses root.",
    );
  }
  return allowed;
}

export function startAdminSocket(options: AdminSocketOptions = {}): {
  stop(): void;
} | null {
  const socketPath = options.socketPath ?? ADMIN_SOCKET_PATH;
  const allowed = resolveAllowedPeerUids(
    options.serverUid ?? process.getuid?.() ?? -1,
    "recoveryUidSetting" in options
      ? options.recoveryUidSetting
      : process.env.ISOMUX_RECOVERY_UID,
  );
  const readPeerUid =
    options.readPeerUid ?? ((fd) => readPeerCredentials(fd)?.uid ?? null);
  // Refuse to start if the path is occupied by something other than a
  // stale Unix socket. A regular file there means the operator (or a
  // misconfigured deployment) put something else at the path - touching
  // it could destroy data.
  if (existsSync(socketPath)) {
    let isSocket = false;
    try {
      isSocket = statSync(socketPath).isSocket();
    } catch (err) {
      console.error(
        `[admin-socket] could not stat ${socketPath}: ${(err as Error).message}; admin socket will be unavailable`,
      );
      return null;
    }
    if (!isSocket) {
      console.error(
        `[admin-socket] ${socketPath} exists and is not a socket; refusing to overwrite. Move it aside and restart Isomux to re-enable the admin socket.`,
      );
      return null;
    }
    try {
      unlinkSync(socketPath);
    } catch (err) {
      console.error(
        `[admin-socket] could not remove stale socket ${socketPath}: ${(err as Error).message}; admin socket will be unavailable`,
      );
      return null;
    }
  }
  // Tighten umask around the bind so the socket is created with mode 0600
  // from the start; the chmod below sets the final mode.
  const prevUmask = process.umask(0o077);
  let server: ReturnType<typeof Bun.listen<ConnectionData>>;
  try {
    server = Bun.listen<ConnectionData>({
      unix: socketPath,
      data: { peerUid: null, buffer: Buffer.alloc(0), handled: false },
      socket: {
        open: (socket) => {
          const fd = socketFileDescriptor(socket);
          socket.data = {
            peerUid: fd === null ? null : readPeerUid(fd),
            buffer: Buffer.alloc(0),
            handled: false,
          };
        },
        data: (socket, chunk) => {
          if (socket.data.handled) return;
          socket.data.buffer = Buffer.concat([
            socket.data.buffer,
            Buffer.from(chunk),
          ]);
          let request: ParsedRequest | null;
          try {
            if (socket.data.buffer.length > MAX_REQUEST_BYTES)
              throw new Error("request too large");
            request = parseHttpRequest(socket.data.buffer, MAX_REQUEST_BYTES);
          } catch {
            socket.data.handled = true;
            socket.end(jsonBytes(400, { ok: false, error: "bad request" }));
            return;
          }
          if (!request) return;
          socket.data.handled = true;
          const peerUid = socket.data.peerUid;
          if (peerUid === null || !allowed.has(peerUid)) {
            console.error(
              `[admin-socket] refused a connection from uid ${peerUid ?? "unknown"}`,
            );
            socket.end(jsonBytes(403, { ok: false, error: refusal(allowed) }));
            return;
          }
          void handleParsed(request, peerUid, options.deps)
            .then(toHttpAsync)
            .then(
              (bytes) => socket.end(bytes),
              () =>
                socket.end(
                  jsonBytes(500, { ok: false, error: "internal error" }),
                ),
            );
        },
      },
    });
  } catch (err) {
    console.error(
      `[admin-socket] failed to bind ${socketPath}: ${(err as Error).message}; admin socket will be unavailable`,
    );
    return null;
  } finally {
    process.umask(prevUmask);
  }
  // A recovery uid other than root needs write access to connect. The peer
  // check, not the mode, is the boundary then.
  const mode = [...allowed].some((uid) => uid !== 0) ? 0o666 : 0o600;
  try {
    chmodSync(socketPath, mode);
  } catch (err) {
    console.error(
      `[admin-socket] chmod ${mode.toString(8)} ${socketPath} failed: ${(err as Error).message}`,
    );
  }
  // Happy-path bind is silent - only failures log.
  return {
    stop: () => {
      server.stop(true);
      try {
        unlinkSync(socketPath);
      } catch {}
    },
  };
}

function refusal(allowed: Set<number>): string {
  if (allowed.size === 0)
    return "Refused: this socket answers no caller while the server runs as root.";
  const names = [...allowed].map((uid) => (uid === 0 ? "root" : `uid ${uid}`));
  return `Refused: this socket answers only ${names.join(" and ")}.`;
}

function handleParsed(
  request: ParsedRequest,
  peerUid: number,
  deps: AdminSocketDeps | undefined,
): Promise<Response> {
  const hasBody = request.method !== "GET" && request.body.length > 0;
  return handleAdmin(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body.toString("utf8") : undefined,
    }),
    peerUid,
    deps,
  );
}

function jsonBytes(status: number, body: unknown): Buffer {
  return httpResponse(status, JSON.stringify(body), "application/json");
}

async function toHttpAsync(response: Response): Promise<Buffer> {
  return httpResponse(
    response.status,
    Buffer.from(await response.arrayBuffer()),
    response.headers.get("content-type") ?? "application/json",
  );
}

async function handleAdmin(
  req: Request,
  peerUid: number,
  deps: AdminSocketDeps | undefined,
): Promise<Response> {
  const url = new URL(req.url);
  // The member OS user verbs (server/member-user-admin.ts) answer root only,
  // not the recovery uid: they make and remove OS users' runtimes.
  if (
    req.method === "POST" &&
    url.pathname.startsWith(MEMBER_USER_PATH_PREFIX)
  ) {
    if (peerUid !== 0)
      return jsonResponse(403, {
        ok: false,
        error: "Refused: the member OS user commands answer only root.",
      });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { ok: false, error: "invalid JSON body" });
    }
    return handleMemberUserAdmin(url.pathname, body);
  }
  // The operator verbs (task 78733adf slice 5a): the same callers as
  // owner-login.
  const operatorVerb = OPERATOR_VERBS[url.pathname];
  if (req.method === "POST" && operatorVerb) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { ok: false, error: "invalid JSON body" });
    }
    return operatorVerb(body, deps);
  }
  if (req.method !== "POST" || url.pathname !== "/admin/owner-login") {
    return jsonResponse(404, { ok: false, error: "not found" });
  }
  let payload: { name?: unknown };
  try {
    payload = (await req.json()) as { name?: unknown };
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) {
    return jsonResponse(400, {
      ok: false,
      error: "--name is required",
    });
  }
  // Refuse pre-claim. The setup form is the right path before an
  // owner exists; pretending to "recover" an account that doesn't exist
  // would be confusing.
  if (!hasOwner()) return noOwnerYet();
  const user = getUserByName(name);
  if (!user) {
    return jsonResponse(404, {
      ok: false,
      error: `No user named "${name}" in this office.`,
    });
  }
  if (user.role !== "owner") {
    return jsonResponse(400, {
      ok: false,
      error: `User "${name}" is a member, not an owner. For a member's sign-in link, POST /admin/sign-in-link with the same body.`,
    });
  }
  // The mint replaces any prior unconsumed link for this user, so repeated
  // CLI runs don't pile up owner-login URLs in invites.json.
  const minted = await mintInvite({
    userId: user.id,
    createdBy: "(admin-cli)",
    ttlMs: OWNER_LOGIN_TTL_MS,
  });
  if (!minted.ok) {
    return jsonResponse(500, { ok: false, error: minted.error });
  }
  recordAudit({
    actor: ADMIN_ACTOR,
    operation: "admin.ownerLogin",
    targets: [user.id],
    fields: [],
  });
  const { origin } = buildPublicOrigin();
  return jsonResponse(200, {
    ok: true,
    url: `${origin}/i/${minted.rawToken}`,
    expiresAt: minted.invite.expiresAt,
    ttlMs: OWNER_LOGIN_TTL_MS,
  });
}

const OPERATOR_VERBS: Record<
  string,
  (body: unknown, deps: AdminSocketDeps | undefined) => Promise<Response>
> = {
  "/admin/sign-in-link": (body, deps) => handleSignInLink(body, deps),
  "/admin/message": (body, deps) => handleAdminMessage(body, deps),
  "/admin/revoke": (body, deps) => handleRevoke(body, deps),
};

// POST /admin/sign-in-link {name}: a one-use sign-in link for any user,
// owner (15 min, as owner-login) or member (INVITE_TTL_MS, as the Invites
// pane). It replaces the user's earlier unused link.
export async function handleSignInLink(
  body: unknown,
  deps: AdminSocketDeps | undefined,
): Promise<Response> {
  const name = stringField(body, "name").trim();
  if (!name) return jsonResponse(400, { ok: false, error: "name is required" });
  if (!hasOwner()) return noOwnerYet();
  const user = getUserByName(name);
  if (!user) return unknownUser(name);
  const ttlMs = user.role === "owner" ? OWNER_LOGIN_TTL_MS : INVITE_TTL_MS;
  const minted = await mintInvite({
    userId: user.id,
    createdBy: "(admin-cli)",
    ttlMs,
  });
  if (!minted.ok) return jsonResponse(500, { ok: false, error: minted.error });
  deps?.invitesChanged();
  recordAudit({
    actor: ADMIN_ACTOR,
    operation: "admin.signInLink",
    targets: [user.id],
    fields: [],
  });
  return jsonResponse(200, {
    ok: true,
    url: `${buildPublicOrigin().origin}/i/${minted.rawToken}`,
    expiresAt: minted.invite.expiresAt,
    ttlMs,
    role: user.role,
  });
}

// POST /admin/message {agent, text}: a message to an agent as from its
// current manager.
export async function handleAdminMessage(
  body: unknown,
  deps: AdminSocketDeps | undefined,
): Promise<Response> {
  const agent = stringField(body, "agent").trim();
  const text = stringField(body, "text");
  if (!agent)
    return jsonResponse(400, { ok: false, error: "agent is required" });
  if (!text.trim())
    return jsonResponse(400, { ok: false, error: "text is required" });
  if (!deps)
    return jsonResponse(503, {
      ok: false,
      error: "This office cannot send messages through the admin socket.",
    });
  const result = await deps.sendMessage(agent, text);
  if (!result.ok)
    return jsonResponse(result.status, {
      ok: false,
      code: result.code,
      error: result.error,
    });
  recordAudit({
    actor: ADMIN_ACTOR,
    operation: "admin.message",
    targets: [result.agentId],
    fields: [],
  });
  return jsonResponse(200, { ok: true, agentId: result.agentId });
}

// POST /admin/revoke {name}: ends every browser session of the user (every
// device, the last owner's too: root can mint a new link at once), then
// removes their unused sign-in links. API tokens stay; the answer counts
// the live ones.
export async function handleRevoke(
  body: unknown,
  deps: AdminSocketDeps | undefined,
): Promise<Response> {
  const name = stringField(body, "name").trim();
  if (!name) return jsonResponse(400, { ok: false, error: "name is required" });
  const user = getUserByName(name);
  if (!user) return unknownUser(name);
  const now = Date.now();
  const apiTokens = listApiTokens(user.id).filter(
    (t) => t.expiresAt === null || t.expiresAt > now,
  ).length;
  // Sessions first, fail closed: they end in memory even when the write
  // fails, and come back at a restart.
  const sessions = await evictSessionsForUserId(user.id);
  recordAudit({
    actor: ADMIN_ACTOR,
    operation: "admin.revoke",
    targets: [user.id],
    fields: [],
  });
  // Then the links, also when the sessions write failed: a live link would
  // sign the person in again at once.
  let links = 0;
  let linksSaved = true;
  try {
    links = await revokeInvitesForUser(user);
  } catch (err) {
    linksSaved = false;
    console.error(`[admin-socket] revoke: the invites write failed:`, err);
  }
  if (links > 0) deps?.invitesChanged();
  if (!sessions.saved || !linksSaved)
    return jsonResponse(500, {
      ok: false,
      sessions: sessions.count,
      links,
      apiTokens,
      error: [
        sessions.saved
          ? "Signed out."
          : "Signed out now, but the sessions file could not be written, so the sessions come back at a restart.",
        linksSaved
          ? "The sign-in links are removed."
          : "The invites file could not be written, so the sign-in links still work.",
        "Run the command again.",
      ].join(" "),
    });
  return jsonResponse(200, {
    ok: true,
    sessions: sessions.count,
    links,
    apiTokens,
  });
}

const ADMIN_ACTOR = {
  kind: "admin_cli",
  id: "admin-cli",
  name: "admin-cli",
} as const;

function stringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function unknownUser(name: string): Response {
  return jsonResponse(404, {
    ok: false,
    error: `No user named "${name}" in this office.`,
  });
}

// Before the office is claimed, the setup form is the way in: no verb mints
// a link for an account no owner made.
function noOwnerYet(): Response {
  const port = process.env.PORT || "4000";
  return jsonResponse(400, {
    ok: false,
    error: `No owner exists yet. Claim the office first: open http://localhost:${port}/setup on this machine (or via ssh -L from another) and enter the setup key, ${activeSetupKeySource() === "configured" ? "the value of ISOMUX_SETUP_KEY" : `which is in ${setupKeyFile()}`}. Once an owner is set, this command can mint a login URL.`,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
