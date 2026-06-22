// Unit tests for the client-side REST helper (Phase 3 transport slice 1). Pins
// the reusable harness the whole client cutover rides on: request shaping,
// envelope/204 handling, ApiError, and demo-shim routing. The network is mocked
// (globalThis.fetch); the demo shim is exercised without any demo-server import.

import { describe, it, expect, afterEach } from "bun:test";
import { apiFetch, ApiError, setApiShim } from "./api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setApiShim(null);
});

function mockFetch(
  res: Response,
  capture?: (input: unknown, init?: RequestInit) => void,
): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    capture?.(input, init);
    return res;
  }) as typeof fetch;
}

describe("apiFetch", () => {
  it("sends a JSON body + same-origin credentials on a mutation and parses the response", async () => {
    let seenPath: unknown;
    let seenInit: RequestInit | undefined;
    mockFetch(
      new Response(JSON.stringify({ ok: true, keyCount: 3 }), { status: 200 }),
      (p, i) => {
        seenPath = p;
        seenInit = i;
      },
    );
    const r = await apiFetch<{ ok: boolean; keyCount: number }>(
      "POST",
      "/api/validate/env",
      { scope: "office" },
    );
    expect(r).toEqual({ ok: true, keyCount: 3 });
    expect(seenPath).toBe("/api/validate/env");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.credentials).toBe("same-origin");
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(seenInit?.body).toBe(JSON.stringify({ scope: "office" }));
  });

  it("omits body + Content-Type on a bodyless call", async () => {
    let seenInit: RequestInit | undefined;
    mockFetch(
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
      (_p, i) => {
        seenInit = i;
      },
    );
    await apiFetch("GET", "/api/backends/codex/models");
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.body).toBeUndefined();
    expect(seenInit?.headers).toBeUndefined();
  });

  it("returns undefined for a 204 no-content response", async () => {
    mockFetch(new Response(null, { status: 204 }));
    const r = await apiFetch("DELETE", "/api/tasks/abc");
    expect(r).toBeUndefined();
  });

  it("throws ApiError carrying the server error envelope on a non-2xx response", async () => {
    mockFetch(
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: "nope" } }),
        { status: 403 },
      ),
    );
    let err: unknown;
    try {
      await apiFetch("POST", "/api/validate/env", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "nope",
    });
  });

  it("falls back to a synthetic code when the error body is not an envelope", async () => {
    mockFetch(new Response("boom", { status: 500 }));
    let err: unknown;
    try {
      await apiFetch("POST", "/api/x", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe("http_500");
  });

  it("routes to the demo shim instead of the network when one is set", async () => {
    let networkHit = false;
    globalThis.fetch = (() => {
      networkHit = true;
      throw new Error("network should not be hit in demo mode");
    }) as unknown as typeof fetch;
    setApiShim(async (method, path, body) => ({ method, path, body }));
    const r = await apiFetch("POST", "/api/validate/cwd", { cwd: "/x" });
    expect(r).toEqual({
      method: "POST",
      path: "/api/validate/cwd",
      body: { cwd: "/x" },
    });
    expect(networkHit).toBe(false);
  });
});
