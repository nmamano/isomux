// The office while it is locked (task cdd7883d). The boot gate in
// server/isomux-office.ts runOfficeMain starts this instead of the office when
// a lock marker exists (server/lockdown.ts). It imports nothing from
// server/isomux-office.ts or server/office-managers.ts: a locked office loads
// no auth state, starts no agent, schedule, cronjob, webhook, bridge or admin
// socket, and holds no provider key.
//
// It stays up, so the unit's Restart=always does not loop and a reboot stays
// locked. GET /readyz answers 200 "locked", so an update still lands; every
// other request, app hosts and WebSocket upgrades included, gets the same
// static 503 page with LOCKED_HEADER.

import { languageFromAcceptLanguage } from "../shared/languages.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import {
  LOCKED_HEADER,
  LOCKED_READY_BODY,
  quarantineCredentials,
  stopAppsForLock,
  type LockdownApps,
} from "./lockdown.ts";
import { sweepExportFiles } from "./office-export-jobs.ts";

export interface LockedOfficeOpts {
  stateRoot: string;
  port: number;
  /** "127.0.0.1" for a loopback bind; undefined binds every interface. */
  hostname?: string;
  apps: LockdownApps;
  /** The backup folder, whose exports/ the lock empties; null when it cannot
   *  be read. */
  exportBaseDir: string | null;
}

export interface LockedOfficeHandle {
  port: number;
  stop(): Promise<void>;
}

// Stricter than the office's own: the page loads nothing and runs nothing.
// No HSTS: a locked office does not read its origin; a browser keeps the
// office's earlier one.
const LOCKED_HEADERS: Record<string, string> = {
  [LOCKED_HEADER]: "1",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/** The answer to any request while the office is locked. */
export function lockedResponse(req: Request): Response {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Not a URL Bun would hand us; it gets the locked page.
  }
  if (path === "/readyz" && (req.method === "GET" || req.method === "HEAD"))
    return new Response(req.method === "HEAD" ? null : LOCKED_READY_BODY, {
      headers: {
        ...LOCKED_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  const i18n = translatorFor(
    languageFromAcceptLanguage(req.headers.get("accept-language")),
  );
  const { t } = i18n;
  const body = `<!doctype html>
<html lang="${i18n.language}">
<head>
<meta charset="utf-8" />
<title>Isomux - ${escapeHtml(t("locked.title"))}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5em; }
</style>
</head>
<body>
<h1>${escapeHtml(t("locked.heading"))}</h1>
<p>${escapeHtml(t("locked.body"))}</p>
</body>
</html>
`;
  return new Response(req.method === "HEAD" ? null : body, {
    status: 503,
    headers: { ...LOCKED_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What a lock does to the state, at the lockdown route's stop and at every
 *  locked boot: moves the credential files aside, deletes owner exports and
 *  stops apps, in that order. Synchronous; each step logs its own failure and
 *  does not skip the next. */
export function applyLockEffects(opts: {
  stateRoot: string;
  apps: LockdownApps;
  /** The backup folder, whose exports/ the lock empties; null when it cannot
   *  be read. */
  exportBaseDir: string | null;
  now: Date;
}): void {
  try {
    const moved = quarantineCredentials(opts.stateRoot, opts.now);
    if (moved.dir)
      console.log(`[lockdown] moved ${moved.moved.join(", ")} to ${moved.dir}`);
  } catch (err) {
    console.error("[lockdown] could not move the credentials aside:", err);
  }
  // No owner export survives a lock (task cdd7883d, slice 4).
  try {
    if (opts.exportBaseDir) sweepExportFiles(opts.exportBaseDir);
  } catch (err) {
    console.error("[lockdown] could not delete the owner exports:", err);
  }
  try {
    const stopped = stopAppsForLock(opts.stateRoot, opts.apps);
    if (stopped.length > 0)
      console.log(`[lockdown] stopped apps: ${stopped.join(", ")}`);
  } catch (err) {
    console.error("[lockdown] could not stop the apps:", err);
  }
}

/** Applies the lock effects again (a safety net: the host command and the
 *  lockdown route's stop already did it unless they could not), and binds the
 *  locked listener. */
export async function startLockedOffice(
  opts: LockedOfficeOpts,
): Promise<LockedOfficeHandle> {
  // Journal only: the host command or the lockdown route audited the lock.
  applyLockEffects({
    stateRoot: opts.stateRoot,
    apps: opts.apps,
    exportBaseDir: opts.exportBaseDir,
    now: new Date(),
  });
  const server = Bun.serve({
    port: opts.port,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    development: false,
    fetch: (req) => lockedResponse(req),
    error: () =>
      new Response("locked\n", { status: 503, headers: LOCKED_HEADERS }),
  });
  console.log(
    `[lockdown] this office is locked; serving the locked page on port ${server.port}`,
  );
  return {
    port: server.port ?? opts.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
