// Which screenshot captures get an app sign-in, and the URL Chrome then loads.
// The grant itself (tables, redeem, gate check) is in app-auth.ts, SCREENSHOT
// GRANTS; preview-capture.ts calls this through its appGrant dep.
//
// A grant is minted only when every check passes. Any other URL - another
// scheme or port, the office host, a label with no live app, a reserved path,
// an app the agent may not open - gets null, and the capture loads the URL as
// it did before grants: an agent without access sees the same sign-in page.
// An agent that may open the app but whose grant cannot be minted (its mint
// budget or the table is spent) gets "refused", never the plain URL: that would
// share the sign-in page as the app.

import type { AppRecord } from "../shared/types.ts";
import type { PreviewAppGrant } from "./preview-capture.ts";
import { appPublicUrl } from "./app-domain.ts";
import {
  APP_PREVIEW_AUTH_PATH,
  mintPreviewGrant,
  validateReturnPath,
} from "./app-auth.ts";
import {
  APP_RESERVED_PATH,
  matchAppHost,
  normalizeRequestHost,
} from "./app-hosts.ts";

export interface PreviewAppGrantDeps {
  // The boot-frozen app-host domain; null when this office has no app hosts.
  domain: string | null;
  apps: () => readonly AppRecord[];
  agentId: string;
  // The calling agent's own access answer for this app record, asked again on
  // every request the capture makes.
  mayOpen: (app: AppRecord) => boolean;
  now?: number;
}

export function previewAppGrant(
  url: URL,
  expiresAt: number,
  deps: PreviewAppGrantDeps,
): PreviewAppGrant | "refused" | null {
  if (deps.domain === null) return null;
  const host = normalizeRequestHost(url.host);
  if (host === null) return null;
  const match = matchAppHost(host, deps.domain);
  if (match === null || match.kind !== "label") return null;
  let app: AppRecord | undefined;
  try {
    app = deps.apps().find((a) => a.hostLabel === match.label);
  } catch {
    return null;
  }
  if (app === undefined) return null;
  // Host and origin come from the registry label and the frozen domain, never
  // from the URL: the URL only has to name that exact origin.
  const origin = appPublicUrl(app.hostLabel, deps.domain);
  if (origin === null || url.origin !== origin) return null;
  if (
    url.pathname === APP_RESERVED_PATH ||
    url.pathname.startsWith(`${APP_RESERVED_PATH}/`)
  )
    return null;
  const returnPath = validateReturnPath(`${url.pathname}${url.search}`);
  if (returnPath === null) return null;
  if (!deps.mayOpen(app)) return null;
  const minted = mintPreviewGrant(
    {
      agentId: deps.agentId,
      app,
      appHost: new URL(origin).hostname,
      returnPath,
      revalidate: deps.mayOpen,
      expiresAt,
    },
    deps.now,
  );
  if (minted === null) return "refused";
  return {
    // The redeem's 302 carries no fragment, so Chrome keeps this one for the
    // page it lands on.
    navigateUrl: `${origin}${APP_PREVIEW_AUTH_PATH}?code=${encodeURIComponent(minted.code)}${url.hash}`,
    release: minted.release,
  };
}
