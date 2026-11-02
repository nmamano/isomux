// The office's front door: the one Bun.serve listener for the office host and
// every app host (HTTP and WebSocket), and the built UI it serves. Moved out of
// server/isomux-office.ts, which creates it once and calls buildServer from
// startServer.
import {
  readWidgetMetadata,
  applyWidgetMetadata,
} from "./app-widget-metadata.ts";
import { stopHasPack } from "../shared/agent-access.ts";
import {
  EXTENSION_SOCKET_PATH,
  extensionUpgradeAllowed,
  type ExtensionWsData,
} from "./browser-extension-service";
import { translatorForRequest } from "./i18n.ts";
import type { Server, ServerWebSocket } from "bun";
import type { ClientCommand, AppRecord, UserRecord } from "../shared/types.ts";
import { removePresence } from "./presence.ts";
import { getUpdateStatus } from "./update-checker.ts";
import { allowOfficeCardRequest, allowReadyRequest } from "./ready-limiter.ts";
import {
  classifyRequest,
  trustedProxy,
  type RequestSource,
} from "./proxy-trust.ts";
import { listUsers, getUserById } from "./users.ts";
import { stopWatch, type FileWatcher } from "./file-editor.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { createStaticAssets } from "./static-assets.ts";
import { join } from "path";
import {
  appNotFoundResponse,
  authenticate,
  resolveIdentityForRequest,
  checkOrigin,
  securityHeaders,
  withSecurityHeaders,
  tryHandleAuthRoute,
} from "./auth-middleware.ts";
import {
  browserSessionDiagnostic,
  buildPublicOrigin,
  emitBrowserSessionDiagnostic,
  isProcessBoundLoopback,
  readSessionCookies,
  registerSocket,
  sessionCookieMigrationHeaders,
  revalidateByHash,
  unregisterSocket,
  validateSession,
  type SessionLookup,
} from "./auth.ts";
import { matchRoute } from "./routes/match.ts";
import { handleMcpRequest, type McpEndpointDeps } from "./mcp-endpoint.ts";
import {
  FOLDER_FILES_MCP_PATH,
  handleFolderMcpRequest,
  type FolderMcpDeps,
} from "./folder-mcp-endpoint.ts";
import { API_ROUTES } from "./routes/table.ts";
import {
  executeRoute,
  errorResponse,
  type ExecutorDeps,
} from "./routes/executor.ts";
import { recordApiReferenceUsage } from "./agent-reference-telemetry.ts";
import {
  appRegistry,
  appRegistrationGeneration,
  RESERVED_APP_NAMES,
} from "./app-registry.ts";
import { appShortUrl } from "./app-short-url.ts";
import {
  matchWebhookIngressPath,
  type WebhookIngress,
} from "./webhooks/ingress.ts";
import { handleAppHostRequest, normalizeRequestHost } from "./app-hosts.ts";
import { appHostDomain, appPublicUrl } from "./app-domain.ts";
import { APP_MINT_PATH } from "./app-auth.ts";
import { neutralNotFound } from "./app-host-responses.ts";
import { TLS_ASK_PATH, handleTlsAsk } from "./tls-ask.ts";
import { type AppRelayWsData } from "./app-ws-relay.ts";
import { officeCardResponse } from "./office-card.ts";
import { OFFICE_CARD_PATH } from "../shared/floors.ts";
import { productionAppProxySecret } from "./app-proxy-secret.ts";
import { loadApiTokens } from "./api-tokens.ts";
import {
  agentManager,
  providerAccountManager,
  appSupervisor,
  extensionService,
} from "./office-managers.ts";
import type { UserPublicWire } from "../shared/contract-shapes.ts";
import type { Identity } from "./identity/index.ts";
import type { OfficeOutbox } from "./office-ws-outbox.ts";
import type {
  ApiTokenWsData,
  OfficeWsData,
  StartServerOpts,
  WsData,
} from "./isomux-office.ts";
import { type WsFrame, type WsPushKind } from "./ws-push-area.ts";

export const UI_DIST = join(import.meta.dir, "..", "ui", "dist");
// Caching and compression of the built UI files (server/static-assets.ts).
const uiAssets = createStaticAssets(UI_DIST);

// Escape a string for safe inclusion as text inside an HTML element (e.g. <title>).
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Serve index.html with the office name substituted into the <title>. The UI
// has `<title>__OFFICE_TITLE__</title>`; we replace that placeholder per-request
// so the tab title is correct before the WS connects (and on the auth page).
async function serveIndexHtml(
  req?: Request,
  session?: SessionLookup,
  widget?: {
    name: string;
    registration: number;
    metadata: Awaited<ReturnType<typeof readWidgetMetadata>>;
  },
): Promise<Response> {
  // A missing bundle (ui/dist not built yet) must be a clean 503, not an
  // unhandled ENOENT that resets the socket mid-response - that crash shape
  // surfaced as CI-only ECONNRESET failures when tests ran before the UI
  // build step.
  const file = Bun.file(join(UI_DIST, "index.html"));
  if (!(await file.exists())) {
    return new Response("UI not built (run: bun run build:ui)", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const raw = await file.text();
  const officeName = agentManager.getOfficeSettings().name;
  const title = officeName ? `${escapeHtml(officeName)} | Isomux` : "Isomux";
  let html = raw.replace("__OFFICE_TITLE__", title);
  if (widget) {
    html = await applyWidgetMetadata(html, widget.metadata);
    const boot = escapeHtml(
      JSON.stringify({ name: widget.name, registration: widget.registration }),
    ).replace(/"/g, "&quot;");
    // The app's own manifest replaces the office's, which applyWidgetMetadata
    // removed. Chrome fetches a manifest without cookies unless the link asks
    // for them.
    const manifest = escapeHtml(
      `/api/apps/${encodeURIComponent(widget.name)}/manifest`,
    );
    html = html.replace(
      "</head>",
      `<meta name="isomux-app-widget" content="${boot}"><link rel="manifest" href="${manifest}" crossorigin="use-credentials"></head>`,
    );
  }
  const res = new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": widget ? "no-store" : "no-cache",
      ...securityHeaders(),
    },
  });
  return req && session ? withCookieMigration(res, req, session) : res;
}

// Attach the session-cookie migration lines (if any) to an already-built
// response. `session` is the caller's ALREADY-VALIDATED cookie session -
// nothing here re-validates, and nothing here re-decides who the caller is.
// A bearer caller has no session and never migrates: an incidental cookie
// sitting in an agent's jar is not what authenticated the request.
function withCookieMigration(
  res: Response,
  req: Request,
  session: SessionLookup,
): Response {
  const lines = sessionCookieMigrationHeaders(readSessionCookies(req), session);
  for (const line of lines) res.headers.append("Set-Cookie", line);
  return res;
}

export const PORT = parseInt(process.env.PORT || "4000");

// OpenCode discovery can spend about 56 seconds in its bounded cold-start poll.
// This also covers the app proxy and the preview route, which can exceed Bun's
// 10-second default while legitimately waiting on an upstream process.
const OFFICE_IDLE_TIMEOUT_SECONDS = 120;

function securityTxt(): string {
  return `Contact: mailto:llc@isomux.com
Expires: 2027-08-22T00:00:00Z
Preferred-Languages: en
Canonical: ${buildPublicOrigin().origin}/.well-known/security.txt
Policy: https://github.com/nmamano/isomux/security/policy
`;
}

// What the front door reads from server/isomux-office.ts.
export interface FrontDoorDeps {
  agentVisibleForSession: (session: SessionLookup, agentId: string) => boolean;
  apiTokenSockets: Set<ServerWebSocket<ApiTokenWsData>>;
  browsers: Set<ServerWebSocket<OfficeWsData>>;
  canUserAccessApp: (
    app: AppRecord,
    userId: string,
    identity?: Identity,
  ) => boolean;
  currentWebhookIngress: () => WebhookIngress;
  editorWatchers: Map<string, Map<string, FileWatcher>>;
  executorDeps: () => ExecutorDeps;
  folderMcpDeps: FolderMcpDeps;
  handleInboundMessage: (
    cmd: ClientCommand,
    ws: ServerWebSocket<OfficeWsData>,
  ) => Promise<void>;
  liveTokenSocket: (ws: ServerWebSocket<ApiTokenWsData>) => boolean;
  mcpEndpointDeps: McpEndpointDeps;
  nextConnectionId: () => string;
  officeSend: (
    ws: ServerWebSocket<OfficeWsData>,
    kind: WsPushKind,
    data: string,
  ) => void;
  officeSendLazy: (
    ws: ServerWebSocket<OfficeWsData>,
    frames: Iterator<WsFrame>,
  ) => void;
  outboxes: WeakMap<ServerWebSocket<OfficeWsData>, OfficeOutbox>;
  pushPresenceListToEachWs: () => void;
  replayFrames: (agentIds: string[]) => Iterator<WsFrame>;
  sendCronjobsTo: (ws: ServerWebSocket<OfficeWsData>) => void;
  sendPresenceListTo: (ws: ServerWebSocket<OfficeWsData>) => void;
  sendProjectedFullState: (
    ws: ServerWebSocket<OfficeWsData>,
    options?: { replayLogsForVisible?: boolean },
  ) => void;
  sendSessionContext: (ws: ServerWebSocket<OfficeWsData>) => void;
  sendTasksTo: (ws: ServerWebSocket<OfficeWsData>) => void;
  toPublicWire: (user: UserRecord) => UserPublicWire;
}

export function createFrontDoor(deps: FrontDoorDeps) {
  const {
    agentVisibleForSession,
    apiTokenSockets,
    browsers,
    canUserAccessApp,
    currentWebhookIngress,
    editorWatchers,
    executorDeps,
    folderMcpDeps,
    handleInboundMessage,
    liveTokenSocket,
    mcpEndpointDeps,
    nextConnectionId,
    officeSend,
    officeSendLazy,
    outboxes,
    pushPresenceListToEachWs,
    replayFrames,
    sendCronjobsTo,
    sendPresenceListTo,
    sendProjectedFullState,
    sendSessionContext,
    sendTasksTo,
    toPublicWire,
  } = deps;

  // buildServer: construct the HTTP+WS listener. Extracted from module top-level
  // so startServer() controls when the bind happens (production via
  // import.meta.main; tests via the in-process harness on an ephemeral port).
  // Body left at its prior indentation; prettier normalizes post-review.
  function buildServer(startOpts: StartServerOpts): Server<WsData> {
    // Pre-claim, external-access-off, or an explicit deployment setting keeps
    // the office listener on loopback. A local proxy can still provide outside
    // access without exposing this socket on every interface.
    const BIND_LOOPBACK_ONLY = isProcessBoundLoopback();

    loadApiTokens();
    return Bun.serve<WsData>({
      port: startOpts.port ?? PORT,
      // Without this, Bun answers an uncaught error with its development page
      // (stack, paths, source) unless NODE_ENV=production.
      development: false,
      idleTimeout: OFFICE_IDLE_TIMEOUT_SECONDS,
      // Default is ~128MB, below our 200MB per-file / 400MB per-upload limits, so a
      // large upload would 413 before reaching the handler. Keep this above MAX_TOTAL.
      maxRequestBodySize: 512 * 1024 * 1024, // 512MB
      ...(BIND_LOOPBACK_ONLY ? { hostname: "127.0.0.1" } : {}),
      async fetch(req, server) {
        // Where the request comes from, decided once (server/proxy-trust.ts):
        // whether it is on-box, and the client address the rate limits key on.
        // Read on first use, because an app-host request that is not relayed
        // and not redeemed never needs it.
        let requestSource: RequestSource | undefined;
        const source = (): RequestSource => {
          if (requestSource === undefined) {
            let peer: string | null = null;
            try {
              peer = server.requestIP(req)?.address ?? null;
            } catch {
              peer = null;
            }
            requestSource = classifyRequest(req, peer, trustedProxy());
          }
          return requestSource;
        };
        // Registered-app hostnames divert here, ahead of EVERYTHING - before the
        // URL is even parsed, let alone dispatched. A request whose Host is a
        // strict child of the office host must never reach an office handler, so
        // the classification cannot sit behind any pathname check. Returns null
        // on every other Host, including the office's own - and on every request
        // of every install with no app-host domain resolved.
        // The relay makes the diverted path asynchronous; the office's
        // own path is not, so only the promise this can hand back is awaited.
        const appHostResponse = handleAppHostRequest(req, {
          supervisor: appSupervisor,
          canAccess: canUserAccessApp,
          memberName: (userId) => getUserById(userId)?.name ?? null,
          proxySecretFor: productionAppProxySecret,
          // A thunk, not a value: reading the peer is only worth doing for a
          // request that is actually being relayed, and this runs in front of
          // every request the office serves.
          peer: () => server.requestIP(req)?.address ?? null,
          client: () => source().client,
          // The only way an app host can turn a request into a socket. The arm
          // never sees the server itself. The headers it passes carry the app's
          // own subprotocol selection, which the runtime would otherwise answer
          // for itself.
          upgrade: (request, data, headers) =>
            server.upgrade(request, headers ? { data, headers } : { data }),
        });
        // `await` can resolve to undefined here, and only on one path: the
        // WebSocket relay upgraded the request, so the socket belongs to the
        // runtime and there is no response to give. That is what Bun's fetch
        // wants back for an upgraded request.
        if (appHostResponse) return await appHostResponse;

        const officeHostResponse = await (async () => {
          // A Host that does not parse (a bad port, a space) leaves a URL that
          // does not parse either. Inside the IIFE, so the 400 keeps the
          // security headers.
          const url = URL.parse(req.url);
          if (!url) return new Response("Bad request", { status: 400 });

          if (url.pathname === EXTENSION_SOCKET_PATH) {
            if (!extensionUpgradeAllowed(req, buildPublicOrigin().origin))
              return new Response("Browser connection refused", {
                status: 403,
              });
            if (
              server.upgrade(req, {
                data: { kind: "extension", origin: req.headers.get("origin")! },
              })
            )
              return;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }

          // WebSocket upgrade - authenticated and origin-checked. The upgrade
          // carries the session into ws.data so per-message handlers can attribute
          // writes without trusting client-supplied username fields.
          if (url.pathname === "/ws") {
            // Unlike HTTP, a bad explicit bearer never falls back to cookies.
            // Browser WebSockets cannot set this header, so it is deliberate.
            const authorization = req.headers.get("Authorization");
            if (authorization !== null) {
              const identity = resolveIdentityForRequest(
                req,
                null,
                source().onBox,
              );
              if (
                identity?.scope !== "api" ||
                !identity.apiTokenId ||
                !identity.userId
              )
                return new Response("unauthenticated", { status: 401 });
              if (!identity.capabilities.includes("api:drain-inbox"))
                return new Response("forbidden", { status: 403 });
              const upgraded = server.upgrade(req, {
                data: {
                  kind: "api" as const,
                  tokenId: identity.apiTokenId,
                  userId: identity.userId,
                },
              });
              if (upgraded) return;
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            const wsCookies = readSessionCookies(req);
            const wsSession = validateSession(wsCookies.selected || null);
            emitBrowserSessionDiagnostic(
              browserSessionDiagnostic(wsCookies, wsSession, "ws"),
              req,
            );
            if (!wsSession) {
              return new Response("unauthenticated", { status: 401 });
            }
            if (!checkOrigin(req)) {
              // Caller already passed cookie auth, so naming the expected origin
              // leaks nothing and saves an on-box debugging round.
              const { origin: expectedOrigin } = buildPublicOrigin();
              return new Response(`bad origin (expected ${expectedOrigin})`, {
                status: 403,
              });
            }
            // The cookie migration rides the 101. This is the seam that reaches an
            // already-open tab: a running SPA can reconnect its socket for days
            // without ever loading a page again, so a page-load-only migration
            // would leave exactly the population this hardening is for. Verified
            // in real Chrome that a Set-Cookie on an upgrade response is committed
            // and returned on the next request. Multi-value MUST go through
            // Headers.append - an array passed in the plain object is dropped.
            const wsMigration = sessionCookieMigrationHeaders(
              wsCookies,
              wsSession,
            );
            const wsHeaders = new Headers();
            for (const line of wsMigration)
              wsHeaders.append("Set-Cookie", line);
            const upgraded = server.upgrade(req, {
              data: {
                kind: "office" as const,
                session: wsSession,
                connectionId: nextConnectionId(),
              },
              ...(wsMigration.length > 0 ? { headers: wsHeaders } : {}),
            });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }

          // GET /readyz - unauthenticated readiness probe (release-channel slice
          // C1; PUBLIC_ROUTES carries the bypass metadata). Reaching this handler
          // already proves readiness: startServer runs the startup migrations
          // (bootPrelude, migrateOwnersToRuleBasedAccess) BEFORE buildServer
          // binds, so a served request implies migrations completed. The body is
          // deliberately state-free ("ok" only - no version, no office info).
          // Callers are rate-limited per client; an on-box caller is exempt so
          // the updater's post-restart poll can never trip the limit and
          // manufacture a rollback. A proxied request is never on-box, so public
          // traffic through Caddy is limited too.
          if (url.pathname === "/readyz" && req.method === "GET") {
            const { onBox, client } = source();
            if (!onBox) {
              if (!allowReadyRequest(client, Date.now())) {
                return new Response("rate limited\n", { status: 429 });
              }
            }
            return new Response("ok\n", {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }

          // GET /.well-known/isomux-office - the public office card another
          // office reads before it adds this one as a floor (server/office-card.ts;
          // PUBLIC_ROUTES carries system.officeCard). Rate-limited like /readyz,
          // on a budget of its own, with the same on-box exemption.
          if (url.pathname === OFFICE_CARD_PATH && req.method === "GET") {
            const { onBox, client } = source();
            if (!onBox && !allowOfficeCardRequest(client, Date.now())) {
              return new Response("rate limited\n", { status: 429 });
            }
            return officeCardResponse(agentManager.getOfficeSettings().name);
          }

          // POST /hooks/:id - the public webhook delivery route
          // (internal-docs/webhooks-design.md section 1; PUBLIC_ROUTES carries
          // hooks.deliver). Before the auth wall: the signature is the only
          // gate. Office host only, because the app-host divert above has run.
          const webhookId = matchWebhookIngressPath(url.pathname);
          if (webhookId !== null) {
            return currentWebhookIngress().handle(req, webhookId);
          }

          if (
            url.pathname === "/.well-known/security.txt" &&
            (req.method === "GET" || req.method === "HEAD")
          ) {
            return new Response(securityTxt(), {
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }

          // GET /__isomux/tls-ask - the certificate admission gate for app
          // hostnames. The terminator calls it directly before
          // obtaining a certificate AND before loading one it already has in
          // storage, so this answers on every cold load, not once per name. It
          // approves the office's own host and live app labels, and denies
          // everything else, including every request that came through a proxy
          // (server/tls-ask.ts). Unauthenticated, and here rather than behind the
          // auth wall for the same reason /readyz is: the caller is a service on
          // this box with no session to present. That placement is also what makes
          // a version mismatch safe - an office that predates this route answers
          // 401 from the wall, which is not a 2xx, so it issues nothing.
          if (url.pathname === TLS_ASK_PATH && req.method === "GET") {
            return handleTlsAsk(url, source().unproxied, {
              domain: appHostDomain(),
              isLive: (label) => appRegistry.isLiveHostLabel(label),
            });
          }

          // /auth/* and /i/<token> routes. These must run before the gating check
          // because unauthenticated visitors transition to authenticated through
          // them. Pass the office name so pre-auth pages render the same tab
          // title format (`<name> | Isomux - ...`) the SPA shell uses.
          const officeName = agentManager.getOfficeSettings().name;
          const authResponse = await tryHandleAuthRoute(
            req,
            url,
            officeName,
            source(),
          );
          if (authResponse) return authResponse;

          // PWA manifest + app icons: iOS Safari fetches these out-of-band when
          // "Add to Home Screen" runs, and the apple-touch-icon fetch in particular
          // can happen without the page's cookies. If 401'd here the PWA tile
          // shows a generic icon and the manifest's name/colors don't apply.
          // Whitelisted unauthenticated; they're public marketing-grade assets
          // baked at build time and contain no deployment state. URL.pathname is
          // normalized by the parser so path-traversal via .. can't escape /icons/.
          if (
            req.method === "GET" &&
            (url.pathname === "/manifest.json" ||
              url.pathname.startsWith("/icons/"))
          ) {
            const f = Bun.file(join(UI_DIST, url.pathname));
            if (await f.exists()) {
              return new Response(f, {
                headers: {
                  "Content-Type": mimeTypeForFilename(url.pathname),
                  "Cache-Control": "public, max-age=31536000, immutable",
                },
              });
            }
            // fall through to the 404 path below if the asset isn't on disk
          }

          // Short app link. Only the lookup happens here: GET and HEAD both wait
          // for office auth and visibility, so a stranger gets the same answer
          // for a live name and an unknown one. On another host (localhost, a
          // tailnet name) the lookup only serves the redirect to the office host.
          let requestedApp: AppRecord | null = null;
          let appAddress = false;
          const onAppDomainHost =
            normalizeRequestHost(req.headers.get("host")) === appHostDomain();
          if (
            (req.method === "GET" || req.method === "HEAD") &&
            appHostDomain() !== null
          ) {
            // /<name>, /<name>/ and /<name>/<page of the app> (task 469e8886).
            const match = /^\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\/.*)?$/.exec(
              url.pathname,
            );
            if (match && !RESERVED_APP_NAMES.has(match[1])) {
              appAddress = true;
              try {
                requestedApp = appRegistry.get(match[1]);
              } catch (err) {
                // The address then opens no app; the office stays one link away.
                console.error("[apps] could not resolve short link:", err);
              }
            }
          }

          // Isomux's file tools for a Codex agent at the folder or web stop:
          // its own token only, judged by the endpoint from the agent record.
          if (url.pathname === FOLDER_FILES_MCP_PATH) {
            try {
              return await handleFolderMcpRequest(
                req,
                resolveIdentityForRequest(req, null, source().onBox),
                folderMcpDeps,
              );
            } catch (err) {
              console.error(`[${FOLDER_FILES_MCP_PATH}] uncaught error:`, err);
              return errorResponse(500, "internal", "internal");
            }
          }

          // The MCP endpoint takes a personal API token, or the token of an
          // agent at the office, folder or web stop (its one way into the
          // office). As on /ws, the cookie is never read and Origin is not
          // checked: a bearer is not an ambient credential, and Claude's servers
          // may send their own Origin.
          if (url.pathname === "/mcp") {
            const identity = resolveIdentityForRequest(
              req,
              null,
              source().onBox,
            );
            if (!identity) {
              const res = errorResponse(
                401,
                "unauthenticated",
                "unauthenticated",
              );
              res.headers.set("WWW-Authenticate", "Bearer");
              return res;
            }
            const apiToken = identity.scope === "api" && !!identity.apiTokenId;
            const packedAgent =
              identity.scope === "agent" &&
              !!identity.agentId &&
              identity.agentAccess !== undefined &&
              stopHasPack(identity.agentAccess);
            if (!apiToken && !packedAgent)
              return errorResponse(403, "forbidden", "forbidden");
            try {
              return await handleMcpRequest(req, identity, mcpEndpointDeps);
            } catch (err) {
              console.error("[/mcp] uncaught error:", err);
              return errorResponse(500, "internal", "internal");
            }
          }

          // Unified REST surface. Routes declared in the typed table are
          // dispatched through the executor: identity -> authorize -> preconditions
          // -> idempotency -> handler -> emit. Identity is REQUIRED (cookie or
          // bearer). Most rows are /api paths; GET /agents and GET /auth/app are
          // the two outside it. An /api path no row takes gets a JSON 404 below,
          // before the static serve.
          {
            const apiMatch = matchRoute(API_ROUTES, req.method, url.pathname);
            if (apiMatch && executorDeps().handlers.has(apiMatch.route.opId)) {
              const apiAuth = authenticate(req, source().onBox, { officeName });
              if (apiAuth.kind !== "ok") {
                // A browser navigation keeps the wall's login page: the chat
                // links attachments under /api/files, and a signed-out member
                // who opens one must be able to sign in. Any other rejection is
                // the envelope {error:{code,message}}. authenticate() rejects
                // with only two statuses: 403 (bad origin / CSRF) and 401 (no /
                // invalid identity).
                if (
                  apiAuth.response.headers
                    .get("content-type")
                    ?.startsWith("text/html")
                ) {
                  return apiAuth.response;
                }
                const badOrigin = apiAuth.response.status === 403;
                return badOrigin
                  ? errorResponse(403, "bad_origin", "bad origin")
                  : errorResponse(401, "unauthenticated", "unauthenticated");
              }
              // Sampled before the call: a self handoff or new-conversation
              // replaces the session that made it.
              const callerSessionId =
                apiAuth.identity.scope === "agent" && apiAuth.identity.agentId
                  ? agentManager.getCurrentSessionId(apiAuth.identity.agentId)
                  : null;
              try {
                const apiRes = await executeRoute(
                  apiMatch,
                  req,
                  apiAuth.identity,
                  executorDeps(),
                  // Thread the caller's own session hash (cookie path only) so
                  // sessions.logout + the logout lockout precondition act on the
                  // caller's session WITHOUT re-validating the cookie in the seam.
                  { callerSessionIdHash: apiAuth.session?.sessionIdHash },
                );
                if (apiRes.status < 400) {
                  await recordApiReferenceUsage(
                    apiMatch,
                    apiAuth.identity,
                    apiRes,
                    callerSessionId,
                  );
                }
                // Cookie migration rides SAFE methods only. A GET/HEAD cannot
                // revoke the session it would re-issue; DELETE
                // /api/sessions/current is exactly that hazard, and a
                // self-targeted revoke is the same shape. A signed-in SPA makes
                // plenty of GETs, so nothing is lost by the restriction.
                const safeMethod =
                  req.method === "GET" || req.method === "HEAD";
                return safeMethod && apiAuth.session
                  ? withCookieMigration(apiRes, req, apiAuth.session)
                  : apiRes;
              } catch (err) {
                console.error("[/api] uncaught executor error:", err);
                return errorResponse(500, "internal", "internal");
              }
            }
          }

          // There is NO loopback bypass left: every caller needs an identity (a
          // bearer token or a session cookie), on this surface and on /api alike.
          // The last three loopback-trusted prefixes - /tasks, the /cronjobs reads
          // and /backup/status - were retired in favour of their bearer-gated /api
          // equivalents (see the retired-path wall below), because a loopback
          // caller is not a trustworthy identity on a box that also runs
          // agent-built web apps: an SSRF or open-proxy bug in any of them reaches
          // a loopback listener in two hops, and the final socket cannot tell who
          // the original caller was.
          const auth = authenticate(req, source().onBox, { officeName });
          if (auth.kind === "rejected") return auth.response;

          // App and API tokens stop here. Everything below gates on "is there
          // an identity" alone (the app short-link shell, the retired-path walls,
          // the static UI); the route table above decides what those tokens
          // reach. 403, not 401: the token is real and isomux knows whose it is.
          if (auth.identity.scope === "app" || auth.identity.scope === "api") {
            return new Response(JSON.stringify({ error: "forbidden" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }

          const canOpenApp =
            requestedApp !== null &&
            !!auth.identity.userId &&
            canUserAccessApp(requestedApp, auth.identity.userId);
          if (appAddress && !onAppDomainHost) {
            // Apps open only on the office host. A hidden or unknown name keeps
            // the office shell here, so no answer tells whether it exists. The
            // path is appended as text: //evil.example stays on the office.
            if (canOpenApp) {
              return new Response(null, {
                status: 302,
                headers: {
                  Location: `${buildPublicOrigin().origin}${url.pathname}${url.search}`,
                  "Cache-Control": "no-store",
                },
              });
            }
          } else if (appAddress) {
            const app = requestedApp;
            if (app && canOpenApp) {
              const publicUrl = appPublicUrl(app.hostLabel, appHostDomain());
              if (req.method === "HEAD") {
                // HEAD keeps the old bodyless redirect to the app itself, at
                // the page the address names. The pathname setter keeps the
                // app's origin whatever the page is (//evil.example included).
                if (
                  appShortUrl(app, publicUrl, buildPublicOrigin().origin) !==
                  null
                ) {
                  const target = new URL(publicUrl!);
                  target.pathname =
                    url.pathname.slice(app.name.length + 1) || "/";
                  target.search = url.search;
                  return new Response(null, {
                    status: 302,
                    headers: {
                      Location: target.href,
                      "Cache-Control": "no-store",
                    },
                  });
                }
              } else if (url.pathname === `/${app.name}`) {
                // The install manifest's scope is /<app>/: the page moves inside
                // it. Only here, so a hidden or unknown name gets no redirect.
                return new Response(null, {
                  status: 302,
                  headers: {
                    Location: `/${app.name}/${url.search}`,
                    "Cache-Control": "no-store",
                  },
                });
              } else {
                return serveIndexHtml(req, auth.session, {
                  name: app.name,
                  registration: appRegistrationGeneration(app),
                  metadata: await readWidgetMetadata({
                    app,
                    host: new URL(publicUrl!).host,
                    apps: appRegistry.list(),
                    supervisor: appSupervisor,
                    proxySecret: () => productionAppProxySecret(app),
                  }),
                });
              }
            }
            // A hidden app, an unknown name and an unreadable registry get one
            // page (task 38f33af3). The office shell would rewrite the address
            // to "/" and show the office with no word of why.
            return appNotFoundResponse(
              req,
              translatorForRequest(
                auth.identity,
                req.headers.get("accept-language"),
              ),
              officeName,
            );
          }

          // The app sign-in mint (apps.mintSignIn) is a GET route. Another method
          // on its path gets the mint's neutral 404, not the SPA shell.
          if (url.pathname === APP_MINT_PATH) return neutralNotFound();

          // Retired legacy surfaces: /tasks*, /cronjobs* and /backup/status. These
          // were unprefixed, loopback-trusted aliases of routes that now live on the
          // bearer-gated /api surface (/api/tasks*, /api/cronjobs*, /api/cron-runs,
          // /api/backup/status), which is where every caller - agents included - is
          // told to go. A no-identity request never reaches here: it 401s at the
          // cookie wall above. GET/HEAD of the task and schedule page paths can
          // reach the SPA shell. Other authenticated calls get a JSON 404 rather than
          // falling through to the SPA shell, which would answer 200 text/html and
          // mask the caller. Note the two things that went away with the handlers:
          // the anonymous loopback trust, and the `Access-Control-Allow-Origin: *`
          // these routes put on their responses and OPTIONS preflight.
          //
          // Matched on a NORMALIZED path, because `URL` leaves `%2f` encoded and a
          // raw-pathname match would let `/tasks%2fabc` or `/backup/status/` slip
          // through to the SPA shell - a 200 text/html answer to a caller still
          // using a retired route, which is the thing this wall exists to prevent.
          // One decode pass only: `%252f` decodes to the literal text `%2f`, not a
          // separator, and no handler is behind any of these paths either way.
          const retiredPath =
            url.pathname.replace(/%2f/gi, "/").replace(/\/+$/, "") || "/";
          const boardPageRequest =
            (req.method === "GET" || req.method === "HEAD") &&
            /^\/(tasks|cronjobs)\/*$/.test(url.pathname);
          if (
            (!boardPageRequest &&
              (retiredPath === "/tasks" ||
                retiredPath.startsWith("/tasks/") ||
                retiredPath === "/cronjobs" ||
                retiredPath.startsWith("/cronjobs/"))) ||
            retiredPath === "/backup/status"
          ) {
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }

          // The legacy non-/api agent surface is fully retired: GET /agents is the
          // only route left on it. The inter-agent message endpoint moved to POST
          // /api/agents/:id/messages (the unified agents.sendMessage route: the
          // AGENT bearer IS the sender, the structured sender is server-derived,
          // and a mismatched body.senderAgentId -> 403 via the messageSend guard).
          // The self-affordance POSTs (diff / edit-file / read-file /
          // terminal-command) moved to /api/agents/:id/* in the loopback-bypass
          // removal milestone. So any other method on /agents or under it is a
          // stale/unknown path: fail closed with a JSON 404 rather than fall
          // through to the SPA shell (which would return 200 text/html and mask the
          // caller). No-bearer requests never reach here - they 401 at the cookie
          // wall above.
          if (
            (retiredPath === "/agents" || retiredPath.startsWith("/agents/")) &&
            req.method !== "GET" &&
            req.method !== "HEAD"
          ) {
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }

          // An /api path that no route took is a wrong or retired route: answer
          // the executor's own 404 envelope, not the SPA shell's 200 text/html.
          // Matched after one %2f decode, as the retired wall above is, so
          // `/api%2fx` cannot reach the shell.
          if (url.pathname.replace(/%2f/gi, "/").startsWith("/api/")) {
            return errorResponse(404, "not_found");
          }

          // Static file serving. The shell carries the cookie migration (the seam
          // for a plain page load or reload); `auth.session` is set only on the
          // cookie path, so a bearer-authenticated shell request migrates nothing.
          const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
          if (filePath === "/index.html") {
            return serveIndexHtml(req, auth.session);
          }
          const asset = await uiAssets.serve(req, filePath);
          if (asset) return asset;
          return serveIndexHtml(req, auth.session);
        })();
        if (!officeHostResponse) return;
        return withSecurityHeaders(officeHostResponse);
      },
      websocket: {
        // The three callbacks below serve two entirely different populations, so
        // each one starts by asking which it has. An app-relay socket is handed
        // straight to its relay object and NOTHING of the office's own machinery
        // runs for it - no roster, no presence, no command parsing. The cast after
        // the check is the narrowing TypeScript cannot do through the generic:
        // `ws.data` is discriminated, but `ServerWebSocket<T>` is invariant in T,
        // so the runtime check is what makes it sound.
        open(socket) {
          if (socket.data.kind === "extension") {
            extensionService!.open(socket as ServerWebSocket<ExtensionWsData>);
            return;
          }
          if (socket.data.kind === "api") {
            const ws = socket as ServerWebSocket<ApiTokenWsData>;
            if (liveTokenSocket(ws)) apiTokenSockets.add(ws);
            return;
          }
          if (socket.data.kind === "app") {
            socket.data.relay.attachBrowser(
              socket as ServerWebSocket<AppRelayWsData>,
            );
            return;
          }
          const ws = socket as ServerWebSocket<OfficeWsData>;
          browsers.add(ws);
          registerSocket(ws.data.session.sessionIdHash, ws);
          // Send session context FIRST so the client knows the authenticated
          // identity and role before any reducer touches state. connectionId
          // is per-WS (live-avatars) so the client can identify its OWN
          // ghost in presence_list - same auth session can be running in
          // multiple tabs and each tab has a distinct connectionId.
          sendSessionContext(ws);
          // Roster hydration: every socket gets the PUBLIC roster; owners
          // additionally get the full admin roster; and the caller gets their OWN
          // full record (user_self_updated) - the now-public users_list can no
          // longer carry the caller's grants/notif/default/view, which the UI
          // needs for the current user.
          officeSend(
            ws,
            "users_list",
            JSON.stringify({
              type: "users_list",
              users: listUsers().map(toPublicWire),
            }),
          );
          if (ws.data.session.role === "owner") {
            officeSend(
              ws,
              "users_admin_list",
              JSON.stringify({
                type: "users_admin_list",
                users: listUsers(),
              }),
            );
          }
          const selfUserForHydration = getUserById(ws.data.session.userId);
          if (selfUserForHydration) {
            officeSend(
              ws,
              "user_self_updated",
              JSON.stringify({
                type: "user_self_updated",
                user: selfUserForHydration,
              }),
            );
            void providerAccountManager
              .list(selfUserForHydration.id)
              .then((accounts) => {
                if (browsers.has(ws))
                  officeSend(
                    ws,
                    "provider_accounts_updated",
                    JSON.stringify({
                      type: "provider_accounts_updated",
                      accounts,
                    }),
                  );
              })
              .catch(() => {
                if (browsers.has(ws))
                  officeSend(
                    ws,
                    "provider_accounts_updated",
                    JSON.stringify({
                      type: "provider_accounts_updated",
                      accounts: [
                        {
                          provider: "codex",
                          scope: "office",
                          accountStatus: "unavailable",
                          loginStatus: "idle",
                          canBrowserLogin: false,
                          error: "Could not read your env file.",
                        },
                        {
                          provider: "codex",
                          scope: "personal",
                          accountStatus: "unavailable",
                          loginStatus: "idle",
                          canBrowserLogin: false,
                          error: "Could not read your env file.",
                        },
                        {
                          provider: "claude",
                          scope: "office",
                          accountStatus: "unavailable",
                          loginStatus: "idle",
                          canBrowserLogin: false,
                          error: "Could not read your env file.",
                        },
                        {
                          provider: "claude",
                          scope: "personal",
                          accountStatus: "unavailable",
                          loginStatus: "idle",
                          canBrowserLogin: false,
                          error: "Could not read your env file.",
                        },
                      ],
                    }),
                  );
              });
          }
          // Send projected full_state (rooms + agents filtered to the
          // session's allowedRooms; sessions whose allowedRooms covers
          // every current room get the identity projection).
          sendProjectedFullState(ws);
          // Owners also receive the unfiltered global rooms list so the
          // admin surface (UserSettingsView's Allowed Rooms editor) can
          // grant access to rooms the owner has hidden from their own view.
          if (ws.data.session.role === "owner") {
            officeSend(
              ws,
              "all_rooms_list",
              JSON.stringify({
                type: "all_rooms_list",
                rooms: agentManager.getOrdinaryRooms(),
              }),
            );
          }
          // Send tasks - room-scoped to this session's accessible rooms ∪ globals
          // (same projection as the live per-recipient re-push).
          sendTasksTo(ws);
          // Cronjobs - the ones this session may see, each projected for it.
          sendCronjobsTo(ws);
          // Send update status - always, not only when available: the client
          // needs the mode (and current-version info) even while quiet, and a
          // reconnect after a cleared banner must hydrate the false state.
          officeSend(
            ws,
            "update_status",
            JSON.stringify({ type: "update_status", ...getUpdateStatus() }),
          );
          // Send cached log history and slash commands for each agent the
          // session can see. agentVisibleForSession short-circuits to true
          // for full-access sessions so the gate is free on the fast path.
          // The replay ends with its fence, so the client can swap the whole
          // transcript in at once instead of guessing when the frames stopped.
          // The fence goes out even when nothing was replayed - "the replay is
          // empty" is exactly the case a client cannot infer.
          const session = ws.data.session;
          officeSendLazy(
            ws,
            replayFrames(
              agentManager
                .getAllAgents()
                .filter((agent) => agentVisibleForSession(session, agent.id))
                .map((agent) => agent.id),
            ),
          );
          // Live-avatars: send the current presence snapshot (filtered to
          // rooms this session can see) so the new client renders existing
          // ghosts immediately rather than waiting for the next
          // presence_update from someone else.
          sendPresenceListTo(ws);
        },
        message(socket, data) {
          if (socket.data.kind === "extension") {
            extensionService!.message(
              socket as ServerWebSocket<ExtensionWsData>,
              data,
            );
            return;
          }
          if (socket.data.kind === "api") {
            // Receive-only. Commands remain on the authenticated REST surface.
            liveTokenSocket(socket as ServerWebSocket<ApiTokenWsData>);
            return;
          }
          if (socket.data.kind === "app") {
            socket.data.relay.browserMessage(
              typeof data === "string" ? data : Buffer.from(data),
            );
            return;
          }
          const ws = socket as ServerWebSocket<OfficeWsData>;
          // Per-message session recheck. Revoke kicks in here without a reconnect:
          // revalidateByHash hits the same in-memory map and returns null if the
          // session has been deleted (revoke), expired, or its user removed.
          const fresh = revalidateByHash(ws.data.session.sessionIdHash);
          if (!fresh) {
            ws.send(JSON.stringify({ type: "session_expired" }));
            ws.close();
            return;
          }
          ws.data.session = fresh;
          try {
            const cmd = JSON.parse(data as string) as ClientCommand;
            void handleInboundMessage(cmd, ws);
          } catch (e) {
            console.error("Invalid command:", e);
          }
        },
        // Bun has room again for this socket. Only office sockets queue frames
        // of their own; the other kinds check their buffer on each send.
        drain(socket) {
          if (socket.data.kind !== "office") return;
          outboxes.get(socket as ServerWebSocket<OfficeWsData>)?.drain();
        },
        close(socket, code, reason) {
          if (socket.data.kind === "extension") {
            extensionService!.close(
              socket as ServerWebSocket<ExtensionWsData>,
              code,
              reason,
            );
            return;
          }
          if (socket.data.kind === "api") {
            apiTokenSockets.delete(socket as ServerWebSocket<ApiTokenWsData>);
            return;
          }
          if (socket.data.kind === "app") {
            socket.data.relay.browserClosed(code, reason);
            return;
          }
          const ws = socket as ServerWebSocket<OfficeWsData>;
          browsers.delete(ws);
          // Disposed, not deleted: a late send to this socket stays a no-op.
          outboxes.get(ws)?.dispose();
          unregisterSocket(ws.data.session.sessionIdHash, ws);
          // Drop this connection's editor watchers on disconnect (keyed by
          // connectionId now that the editor is REST - a leaked watch leaks a
          // poll timer for the life of the tab).
          const watchMap = editorWatchers.get(ws.data.connectionId);
          if (watchMap) {
            for (const w of watchMap.values()) stopWatch(w);
            editorWatchers.delete(ws.data.connectionId);
          }
          // Live-avatars cleanup. Idempotent: removePresence returns true
          // only if an entry existed. Key is the per-WS connectionId, NOT
          // the auth session hash - that distinction is what makes
          // reconnects and same-cookie multi-tab work: when a tab reconnects
          // it gets a NEW connectionId, and the OLD close handler here
          // removes only the OLD id, never racing with the new tab's entry.
          if (removePresence(ws.data.connectionId)) {
            pushPresenceListToEachWs();
          }
        },
      },
    });
  } // end buildServer

  return { buildServer };
}
