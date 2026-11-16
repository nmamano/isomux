// The swap-failed server (task 78733adf, slice 2c-1, design round D5): when
// the boot swap of a move-in fails, the process serves only a page with the
// error and a retry that ends the process. It loads no state.

import { describe, expect, it } from "bun:test";
import {
  SWAP_RETRY_MIN_INTERVAL_MS,
  SWAP_RETRY_PATH,
  swapFailedResponse,
} from "./move-swap-failed-office.ts";

const T0 = new Date("2026-11-16T10:00:00Z");
const ORIGIN = "http://127.0.0.1:4000";

// The step and the message hold names from the old office's files.
const FAILURE = {
  step: "in .isomux/<img src=x onerror=alert(1)>",
  message: 'EACCES: permission denied, rename "<b>docs</b>"',
};

function server() {
  let now = T0;
  const restarts = { n: 0 };
  const opts = {
    failure: FAILURE,
    requestRestart: () => {
      restarts.n++;
    },
    now: () => now,
  };
  return {
    restarts,
    at: (ms: number) => {
      now = new Date(T0.getTime() + ms);
    },
    get: (path: string) =>
      swapFailedResponse(new Request(`${ORIGIN}${path}`), opts),
    post: (path: string) =>
      swapFailedResponse(
        new Request(`${ORIGIN}${path}`, { method: "POST" }),
        opts,
      ),
  };
}

describe("the swap-failed server", () => {
  it("serves a page with the error, escaped, and without the failed step", async () => {
    const s = server();
    const res = s.get("/");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;docs&lt;/b&gt;");
    expect(html).not.toContain("<b>docs</b>");
    // The step is for the operator's boot log only (Nil, sign-off of
    // 78733adf): the page shows it in no form, raw or escaped.
    expect(html).not.toContain("onerror");
    // The page offers the retry.
    expect(html).toContain(SWAP_RETRY_PATH);
  });

  it("answers /readyz, so an update still lands", () => {
    expect(server().get("/readyz").status).toBe(200);
  });

  it("serves no office route", async () => {
    const s = server();
    for (const path of ["/api/agents", "/api/office/move-in", "/api/users"]) {
      const res = s.get(path);
      expect([path, res.status >= 400]).toEqual([path, true]);
    }
    expect(s.restarts.n).toBe(0);
  });

  it("the retry ends the process, at most once per interval; a GET does not", () => {
    const s = server();
    expect(s.get(SWAP_RETRY_PATH).status).toBeGreaterThanOrEqual(400);
    expect(s.restarts.n).toBe(0);

    const first = s.post(SWAP_RETRY_PATH);
    expect(first.status).toBeLessThan(400);
    expect(s.restarts.n).toBe(1);

    s.at(SWAP_RETRY_MIN_INTERVAL_MS - 1);
    expect(s.post(SWAP_RETRY_PATH).status).toBe(429);
    expect(s.restarts.n).toBe(1);

    s.at(SWAP_RETRY_MIN_INTERVAL_MS);
    expect(s.post(SWAP_RETRY_PATH).status).toBeLessThan(400);
    expect(s.restarts.n).toBe(2);
  });
});
