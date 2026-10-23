// /api/unsubscribe, the welcome series opt-out.
//
// POST is the RFC 8058 one-click endpoint a mail client calls on its own, with
// no session and no Origin of ours; it must work from there and say nothing
// about whether a token exists. GET is what a client without one-click support,
// or a link scanner, sends to the same URL: it must never unsubscribe.

import { describe, expect, test } from "bun:test";
import {
  handleUnsubscribeGet,
  handleUnsubscribePost,
} from "./unsubscribe-request.server";

const ORIGIN = "https://storefront.example.com";
const TOKEN = "Zm9vYmFyYmF6cXV4LXdlbGNvbWUtbWFpbC10b2tlbg";

function recorder() {
  const tokens: string[] = [];
  return {
    tokens,
    deps: {
      unsubscribe: async (token: string) => {
        tokens.push(token);
      },
    },
  };
}

/** The one-click request as RFC 8058 section 3.2 writes it. */
function oneClick(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: "List-Unsubscribe=One-Click",
  });
}

describe("POST /api/unsubscribe", () => {
  test("a mail client's one-click request unsubscribes the token, with no session and with or without an Origin of its own", async () => {
    // A web mail client may send its own Origin. The token is the whole
    // credential, and all it can do is stop the welcome mails.
    const origins: Record<string, string>[] = [
      {},
      { origin: "https://mail.example.net" },
    ];
    for (const headers of origins) {
      const { tokens, deps } = recorder();
      const response = await handleUnsubscribePost(
        oneClick(`${ORIGIN}/api/unsubscribe?t=${TOKEN}`, headers),
        deps,
      );
      expect([headers, response.status, tokens]).toEqual([
        headers,
        200,
        [TOKEN],
      ]);
    }
  });

  test("a request with no token is refused before the store is asked", async () => {
    const { tokens, deps } = recorder();
    for (const url of [
      `${ORIGIN}/api/unsubscribe`,
      `${ORIGIN}/api/unsubscribe?t=`,
    ]) {
      const response = await handleUnsubscribePost(oneClick(url), deps);
      expect([url, response.status]).toEqual([url, 400]);
    }
    expect(tokens).toEqual([]);
  });
});

describe("GET /api/unsubscribe", () => {
  test("sends the browser to the page with the button", () => {
    const response = handleUnsubscribeGet(
      new Request(`${ORIGIN}/api/unsubscribe?t=${TOKEN}`),
    );
    expect(response.status).toBe(303);
    const location = new URL(
      response.headers.get("location") ?? "",
      `${ORIGIN}/api/unsubscribe`,
    );
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/unsubscribe");
    expect(location.searchParams.get("t")).toBe(TOKEN);
  });
});
