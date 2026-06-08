// Unix-domain admin socket. Bound at ~/.isomux/admin.sock mode 0600. The
// only client is server/admin-cli.ts, which the operator invokes from a
// shell on the same host. Filesystem permissions on the socket are the
// auth boundary — any UID that can connect to the socket can already read
// the auth files in ~/.isomux/, so giving it a clean RPC interface to
// mint an owner-login URL adds no new authority. On a multi-user box
// where ~/.isomux/ is mode 0700 (recommended), only the Isomux service
// user can touch the socket.
//
// One operation today: POST /admin/owner-login. Future admin endpoints
// (rotate a key, dump state, etc.) would land in the same router but are
// out of scope for the auth redesign.

import { chmodSync, existsSync, statSync, unlinkSync } from "fs";
import { STATE_ROOT } from "./config.ts";
import { join } from "path";
import { buildPublicOrigin, mintInvite } from "./auth.ts";
import { getUserByName, hasOwner } from "./users.ts";

const ISOMUX_DIR = STATE_ROOT;
const SOCKET_PATH = join(ISOMUX_DIR, "admin.sock");

// 15 minutes: shell access + immediate hand-off to a browser. Tight enough
// that a forgotten URL on a shared screen expires quickly, loose enough to
// cover device-switching friction (open the URL on a phone after SSH'ing
// from a laptop, etc.).
const OWNER_LOGIN_TTL_MS = 15 * 60 * 1000;

export function startAdminSocket(): void {
  // Refuse to start if the path is occupied by something other than a
  // stale Unix socket. A regular file there means the operator (or a
  // misconfigured deployment) put something else at the path — touching
  // it could destroy data.
  if (existsSync(SOCKET_PATH)) {
    let isSocket = false;
    try {
      isSocket = statSync(SOCKET_PATH).isSocket();
    } catch (err) {
      console.error(
        `[admin-socket] could not stat ${SOCKET_PATH}: ${(err as Error).message}; admin CLI will be unavailable`,
      );
      return;
    }
    if (!isSocket) {
      console.error(
        `[admin-socket] ${SOCKET_PATH} exists and is not a socket; refusing to overwrite. Move it aside and restart isomux to re-enable the admin CLI.`,
      );
      return;
    }
    try {
      unlinkSync(SOCKET_PATH);
    } catch (err) {
      console.error(
        `[admin-socket] could not remove stale socket ${SOCKET_PATH}: ${(err as Error).message}; admin CLI will be unavailable`,
      );
      return;
    }
  }
  // Tighten umask around the bind so the socket is created with mode 0600
  // from the start. Bun.serve creates the inode before any chmod can run;
  // under a permissive umask (e.g. 0002) the brief pre-chmod window would
  // otherwise leave the socket group-connectable. The chmodSync below
  // stays as defense-in-depth in case Bun's underlying syscall ignores
  // umask entirely.
  const prevUmask = process.umask(0o077);
  try {
    Bun.serve({ unix: SOCKET_PATH, fetch: handleAdmin });
  } catch (err) {
    console.error(
      `[admin-socket] failed to bind ${SOCKET_PATH}: ${(err as Error).message}; admin CLI will be unavailable`,
    );
    return;
  } finally {
    process.umask(prevUmask);
  }
  // Force mode 0600 explicitly as defense-in-depth even after the umask
  // tightening above — if Bun's bind path bypasses umask on this platform,
  // chmod still closes the gap.
  try {
    chmodSync(SOCKET_PATH, 0o600);
  } catch (err) {
    console.error(
      `[admin-socket] chmod 0600 ${SOCKET_PATH} failed: ${(err as Error).message}; admin CLI may be reachable by other local users`,
    );
  }
  // Happy-path bind is silent — only failures log. The socket is a quiet
  // affordance for the `owner-login` CLI; users don't need a per-boot
  // confirmation that it's working.
}

async function handleAdmin(req: Request): Promise<Response> {
  const url = new URL(req.url);
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
  // Refuse pre-claim. The tokenless form is the right path before an
  // owner exists; pretending to "recover" an account that doesn't exist
  // would be confusing.
  if (!hasOwner()) {
    const port = process.env.PORT || "4000";
    return jsonResponse(400, {
      ok: false,
      error: `No owner exists yet. Claim the office first by opening http://localhost:${port}/ on this machine (or via ssh -L from another). Once an owner is set, this command can mint a login URL.`,
    });
  }
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
      error: `User "${name}" is a member, not an owner. The owner-login CLI is for owner recovery; have an owner mint a normal invite from the Access pane.`,
    });
  }
  const minted = await mintInvite({
    username: name,
    role: "owner",
    createdBy: "(admin-cli)",
    allowExisting: true,
    // Replace any prior unconsumed invite for this user so we don't pile up
    // owner-login URLs in invites.json on repeated CLI runs.
    replacePriorForUsername: true,
    ttlMsOverride: OWNER_LOGIN_TTL_MS,
  });
  if (!minted.ok) {
    return jsonResponse(500, { ok: false, error: minted.error });
  }
  const { origin } = buildPublicOrigin();
  return jsonResponse(200, {
    ok: true,
    url: `${origin}/i/${minted.rawToken}`,
    expiresAt: minted.invite.expiresAt,
    ttlMs: OWNER_LOGIN_TTL_MS,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
