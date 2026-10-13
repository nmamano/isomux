// A stub authorization server and a stub MCP server behind one fetch
// function (integrations A2b): no real provider, no network. `authorize`
// plays the member's browser.

import { expect } from "bun:test";
import { createHash } from "crypto";

export const MCP_URL = "https://mcp.example.test/mcp";
export const ISSUER = "https://auth.example.test";
// Fake values with a fixed prefix, so one search finds any that leak.
export const LEAK = "fake-oauth-";

export interface StubOptions {
  resource?: string;
  issuer?: string;
  tokenEndpoint?: string;
  registration?: boolean;
  dcrError?: string;
}

export function stubRig(options: StubOptions = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let issued = 0;
  const rig = {
    calls,
    refuseRefresh: false,
    // The token answer of a code exchange leaves out refresh_token.
    noRefreshToken: false,
    registeredRedirects: [] as string[],
    tokenBodies: [] as URLSearchParams[],
    tokenAuth: [] as (string | null)[],
    access: () => `${LEAK}access-${issued}`,
    refreshValue: () => `${LEAK}refresh-${issued}`,
    authorize(authorizationUrl: string): { code: string; state: string } {
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const code = `${LEAK}code-${codes.size + 1}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect: url.searchParams.get("redirect_uri")!,
      });
      return { code, state: url.searchParams.get("state")! };
    },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const headers = new Headers(init.headers);
      if (url === MCP_URL) {
        // The current access token only: initialize and tools/list.
        if (headers.get("authorization") === `Bearer ${rig.access()}`) {
          if (init.method === "DELETE")
            return new Response(null, { status: 200 });
          const message = JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as {
            id?: number;
            method?: string;
          };
          if (message.id === undefined)
            return new Response(null, { status: 202 });
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "stub-mail", version: "1" },
                  }
                : { tools: [{ name: "search" }] },
          });
        }
        return new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (
        url ===
        "https://mcp.example.test/.well-known/oauth-protected-resource/mcp"
      )
        return json({
          resource: options.resource ?? MCP_URL,
          authorization_servers: [ISSUER],
          scopes_supported: ["mail.read"],
        });
      if (url === `${ISSUER}/.well-known/oauth-authorization-server`)
        return json({
          issuer: options.issuer ?? ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${ISSUER}/token`,
          ...(options.registration === false
            ? {}
            : { registration_endpoint: `${ISSUER}/register` }),
          code_challenge_methods_supported: ["S256"],
        });
      if (url === `${ISSUER}/register`) {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "");
        rig.registeredRedirects.push(...body.redirect_uris);
        if (options.dcrError) return json({ error: options.dcrError }, 400);
        return json({ client_id: "client-dcr-1" }, 201);
      }
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(
          typeof init.body === "string" ? init.body : "",
        );
        rig.tokenBodies.push(body);
        rig.tokenAuth.push(headers.get("authorization"));
        if (body.get("grant_type") === "authorization_code") {
          const flow = codes.get(body.get("code") ?? "");
          const verifier = body.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (
            !flow ||
            flow.challenge !== challenge ||
            flow.redirect !== body.get("redirect_uri")
          )
            return json({ error: "invalid_grant" }, 400);
          codes.delete(body.get("code")!);
        } else if (body.get("grant_type") === "refresh_token") {
          if (
            rig.refuseRefresh ||
            body.get("refresh_token") !== rig.refreshValue()
          )
            return json({ error: "invalid_grant" }, 400);
        } else return json({ error: "unsupported_grant_type" }, 400);
        issued += 1;
        return json({
          access_token: rig.access(),
          token_type: "Bearer",
          expires_in: 3600,
          ...(rig.noRefreshToken &&
          body.get("grant_type") === "authorization_code"
            ? {}
            : { refresh_token: rig.refreshValue() }),
        });
      }
      return json({}, 404);
    },
  };
  return rig;
}
