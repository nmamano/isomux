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

  // Without our own address there is nothing to tell a wildcard or stale record
  // from this box, so the probe stops before it asks anything: every scripted
  // rung below would pass, and a pass here is how a down office reads as up.
  test("with no expected address the probe stops at wrong-box before the lookup", async () => {
    for (const missing of [null, undefined, ""]) {
      const calls = { lookup: 0, connect: 0, fetch: 0 };
      const counting = {
        lookup: () => {
          calls.lookup++;
          return Promise.resolve(OURS);
        },
        connect: () => {
          calls.connect++;
          return Promise.resolve();
        },
        fetchImpl: () => {
          calls.fetch++;
          return Promise.resolve(new Response("", { status: 200 }));
        },
      };
      const r = await probeLiveness("cp1.test.isomux.app", counting, missing);
      expect({ missing, rung: r.rung }).toEqual({ missing, rung: "wrong-box" });
      expect(calls).toEqual({ lookup: 0, connect: 0, fetch: 0 });
    }
  });
});

// The control probe decides whether a failed office reading is the office's
// fault or the prober's own network. ok must mean "the prober reached the
// outside world" as deeply as an office probe does: one control host answering
// is enough, and a host that hangs must count as failed within the deadline,
// because the control runs exactly when the resolver is broken.
describe("probeControl", () => {
  const never = () => new Promise<never>(() => {});
  const answers = () => Promise.resolve(new Response("", { status: 200 }));

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
        fetchImpl: answers,
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
        fetchImpl: answers,
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
        fetchImpl: answers,
      },
      ["a.example", "b.example"],
      50,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("a.example");
    expect(r.detail).toContain("b.example");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // 2026-10-25: under packet loss on the VPS a lookup and one TCP connect
  // passed while the offices failed their TLS handshake, so their failures
  // counted as strikes and three offices were raised. The control must
  // complete an HTTPS exchange, as the office probe does.
  test("a host that accepts on 443 but cannot complete an HTTPS exchange is not reachable; any HTTP answer is", async () => {
    const hosts = ["a.example", "b.example"];
    const asked: string[] = [];
    const shallowOnly = await probeControl(
      {
        lookup: () => Promise.resolve("192.0.2.4"),
        connect: () => Promise.resolve(),
        fetchImpl: (url) => {
          asked.push(url);
          return Promise.reject(new Error("handshake reset"));
        },
      },
      hosts,
    );
    expect(shallowOnly.ok).toBe(false);
    expect(shallowOnly.detail).toContain("a.example");
    expect(shallowOnly.detail).toContain("b.example");
    expect(
      asked.map((u) => `${new URL(u).protocol}//${new URL(u).hostname}`).sort(),
    ).toEqual(["https://a.example", "https://b.example"]);

    // The status is not checked: any answer means the exchange completed. Each
    // body is cancelled, so the socket is not held open.
    for (const status of [301, 404, 503]) {
      let cancelled = false;
      const r = await probeControl(
        {
          lookup: () => Promise.resolve("192.0.2.4"),
          connect: () => Promise.resolve(),
          fetchImpl: (url) =>
            new URL(url).hostname === "a.example"
              ? Promise.reject(new Error("handshake reset"))
              : Promise.resolve(
                  new Response(
                    new ReadableStream({
                      cancel() {
                        cancelled = true;
                      },
                    }),
                    { status },
                  ),
                ),
        },
        hosts,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect({ status, ok: r.ok, cancelled }).toEqual({
        status,
        ok: true,
        cancelled: true,
      });
    }
  });

  test("a hanging HTTPS exchange fails within the deadline and is aborted when the probe returns", async () => {
    // The lookup takes part of the deadline, so a fetch timer started after it
    // would still be running when the probe has already given up.
    const signals: (AbortSignal | null | undefined)[] = [];
    const started = Date.now();
    const r = await probeControl(
      {
        lookup: () =>
          new Promise((resolve) => setTimeout(() => resolve("192.0.2.5"), 20)),
        connect: () => Promise.resolve(),
        fetchImpl: (_url, init) => {
          signals.push(init?.signal);
          return never();
        },
      },
      ["a.example", "b.example"],
      50,
    );
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signals.map((s) => s?.aborted)).toEqual([true, true]);
  });
});
