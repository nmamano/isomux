// Unified REST client for the /api surface - the browser counterpart to the
// server's typed route table + executor. As Phase 3 migrates each command off
// the WebSocket command bus, its UI call site swaps a fire-and-forget
// `ws.send()` for an `apiFetch()`: HTTP correlates the response natively, so the
// per-command `requestId` + bespoke `*_response` machinery goes away.
//
// DEMO-AGNOSTIC: this module never imports demo-server.ts. A demo build installs
// a shim via setApiShim(); when one is set, apiFetch routes to it instead of the
// network, so the landing demo keeps working as commands migrate off the WS
// shim. Mirrors the ws.ts setShim() pattern (the WS half of the same idea).

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Thrown for any non-2xx /api response. Carries the server's error envelope
// ({ error: { code, message } }) so call sites can branch on `code` and render
// `message` - the same strings the retired `*_response.error` fields carried.
// `detail` is the FULL error object (code + message + any extra fields the server
// spread in), so a structured failure can carry data past the envelope - e.g. the
// editor's 409 stale-save carries `currentMtime` for the conflict banner.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A demo shim resolves an apiFetch the way the WS shim resolves a command: it
// returns the parsed response body (or undefined for a no-content route) and
// throws ApiError to simulate a failure. Registered by the demo entry; null in
// production. Kept here (not in demo-server) so apiFetch stays demo-agnostic.
export type ApiShim = (
  method: ApiMethod,
  path: string,
  body: unknown,
) => Promise<unknown>;

let apiShim: ApiShim | null = null;

export function setApiShim(fn: ApiShim | null): void {
  apiShim = fn;
}

// Issue a request against the same-origin /api surface. `path` is an app-relative
// path beginning with "/api/". A JSON body is sent only when `body !== undefined`
// (queries send none). Returns the parsed JSON body, or undefined for an empty /
// 204 response. Throws ApiError on any non-2xx response.
export async function apiFetch<T = unknown>(
  method: ApiMethod,
  path: string,
  body?: unknown,
  // Extra request headers (network path only - the demo shim ignores them). The
  // editor rides X-Isomux-Connection-Id here to bind a file watch to this tab's
  // socket (see Conventions › Connection binding).
  opts?: { headers?: Record<string, string> },
): Promise<T> {
  // Dev guard: every route on this surface is under /api/. A caller passing a
  // bare path (e.g. a leftover "/validate/cwd") would silently miss the shim and
  // hit the SPA's catch-all instead of erroring. Cheap startsWith, not URL
  // parsing - the intent is to catch a typo at the call site, not validate URLs.
  if (!path.startsWith("/api/")) {
    throw new Error(`apiFetch: path must start with "/api/" (got "${path}")`);
  }

  if (apiShim) {
    return (await apiShim(method, path, body)) as T;
  }

  const init: RequestInit = { method, credentials: "same-origin" };
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) init.headers = headers;

  const res = await fetch(path, init);

  // 204 (and any empty body) carries nothing to parse.
  const text = res.status === 204 ? "" : await res.text();
  const data = text.length > 0 ? safeParse(text) : undefined;

  if (!res.ok) {
    const env = data as
      | { error?: { code?: string; message?: string } }
      | undefined;
    const code = env?.error?.code ?? `http_${res.status}`;
    const message =
      env?.error?.message ?? res.statusText ?? `Request failed (${res.status})`;
    // Carry the full error object as `detail` so structured failures (e.g. the
    // editor's 409 { code:"stale", currentMtime }) reach the call site.
    throw new ApiError(res.status, code, message, env?.error);
  }

  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
