// GET /auth/app (opId apps.mintSignIn): mint a single-use code for one of this
// office's app hostnames and redirect the browser to it. The handshake lives
// in server/app-auth.ts; this is only the mount. The route's guard admits a
// cookie user only: an agent token has no office session for a code to be
// bound to.

import { fail, type RouteHandler } from "../executor.ts";

export interface AppSignInDeps {
  // handleAppMintRequest with the office's app-host domain and access rule.
  mint(
    req: Request,
    url: URL,
    session: { userId: string; sessionIdHash: string },
  ): Response;
}

export function appSignInHandlers(
  deps: AppSignInDeps,
): Record<string, RouteHandler> {
  return {
    "apps.mintSignIn": ({ identity, req, callerSessionIdHash }) => {
      // The code binds to the caller's own office session.
      if (!identity.userId || !callerSessionIdHash) {
        return fail(403, "forbidden");
      }
      return {
        kind: "response",
        response: deps.mint(req, new URL(req.url), {
          userId: identity.userId,
          sessionIdHash: callerSessionIdHash,
        }),
      };
    },
  };
}
