// Acceptance must mean "this box".
//
// `*.test.isomux.app` already resolves through a wildcard, and the hosted
// product will run many offices behind one zone. A stale or wildcard A record
// plus a healthy office somewhere else is enough for TCP, TLS and /readyz to
// all pass against a machine we did not build - and the run would then report
// a successful handoff for the wrong server.

import { describe, expect, test } from "bun:test";
import { probeLiveness } from "./liveness.ts";

const OURS = "169.58.97.2";
const SOMEONE_ELSE = "203.0.113.9";

function deps(ip: string, readyz = 200) {
  return {
    lookup: () => Promise.resolve(ip),
    connect: () => Promise.resolve(),
    fetchImpl: () => Promise.resolve(new Response("", { status: readyz })),
  };
}

describe("probeLiveness", () => {
  test("a healthy office at OUR address is ok", async () => {
    const r = await probeLiveness("cp1.test.isomux.app", deps(OURS), OURS);
    expect(r.rung).toBe("ok");
  });

  // The one that matters: everything below this rung would have passed.
  test("a healthy office at someone else's address is refused", async () => {
    const r = await probeLiveness(
      "cp1.test.isomux.app",
      deps(SOMEONE_ELSE),
      OURS,
    );
    expect(r.rung).toBe("wrong-box");
    expect(r.detail).toContain(SOMEONE_ELSE);
    expect(r.detail).toContain(OURS);
  });

  test("the rungs below still report their own failures", async () => {
    const dnsFails = {
      lookup: () => Promise.reject(new Error("NXDOMAIN")),
      connect: () => Promise.resolve(),
      fetchImpl: () => Promise.resolve(new Response("", { status: 200 })),
    };
    expect((await probeLiveness("x", dnsFails, OURS)).rung).toBe("dns");

    const notServing = deps(OURS, 503);
    expect((await probeLiveness("x", notServing, OURS)).rung).toBe("readyz");
  });

  test("without an expected address it cannot make the distinction, and says so by not claiming it", async () => {
    // Kept honest rather than convenient: callers that skip the address get the
    // old behaviour, so the acceptance path passes rec.ipv4 and this is only
    // ever a diagnostic probe.
    const r = await probeLiveness("cp1.test.isomux.app", deps(SOMEONE_ELSE));
    expect(r.rung).toBe("ok");
  });
});
