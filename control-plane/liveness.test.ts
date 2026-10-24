// Acceptance must mean "this box".
//
// `*.test.isomux.app` already resolves through a wildcard, and the hosted
// product will run many offices behind one zone. A stale or wildcard A record
// plus a healthy office somewhere else is enough for TCP, TLS and /readyz to
// all pass against a machine we did not build - and the run would then report
// a successful handoff for the wrong server.

import { describe, expect, test } from "bun:test";
import { probeControl, probeLiveness } from "./liveness.ts";

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
  // The one that matters: everything below this rung would have passed.
  test("a healthy office is ok at OUR address and refused at someone else's", async () => {
    const ours = await probeLiveness("cp1.test.isomux.app", deps(OURS), OURS);
    expect(ours.rung).toBe("ok");
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
});

// The control probe decides whether a failed office reading is the office's
// fault or the prober's own network. ok must mean "the prober reached the
// outside world": one control host answering is enough, and a host that hangs
// must count as failed within the deadline, because the control runs exactly
// when the resolver is broken.
describe("probeControl", () => {
  const never = () => new Promise<never>(() => {});

  test("one host resolving and accepting on 443 is enough", async () => {
    const r = await probeControl(
      {
        lookup: (h) =>
          h === "up.example"
            ? Promise.resolve("192.0.2.1")
            : Promise.reject(new Error("SERVFAIL")),
        connect: (_h, port) =>
          port === 443
            ? Promise.resolve()
            : Promise.reject(new Error("refused")),
      },
      ["down.example", "up.example"],
    );
    expect(r.ok).toBe(true);
  });

  test("a lookup failure and a connect failure each fail a host, and the detail names both", async () => {
    // Host a fails at the lookup, host b resolves and then refuses: a probe
    // that skipped the connect would call b reachable.
    const r = await probeControl(
      {
        lookup: (h) =>
          h === "a.example"
            ? Promise.reject(new Error("SERVFAIL"))
            : Promise.resolve("192.0.2.2"),
        connect: () => Promise.reject(new Error("ECONNREFUSED")),
      },
      ["a.example", "b.example"],
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("a.example");
    expect(r.detail).toContain("b.example");
  });

  test("a host that hangs fails within the deadline, at the lookup or at the connect", async () => {
    // a hangs in the lookup (getaddrinfo has no timeout of its own), b hangs
    // in the connect. The deadline covers both steps of each host.
    const started = Date.now();
    const r = await probeControl(
      {
        lookup: (h) =>
          h === "a.example" ? never() : Promise.resolve("192.0.2.3"),
        connect: never,
      },
      ["a.example", "b.example"],
      50,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("a.example");
    expect(r.detail).toContain("b.example");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
