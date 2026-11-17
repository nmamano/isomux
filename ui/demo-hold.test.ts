// The demo hold of scripts/loading-check.sh (task d3593a12). The contract:
// with no hold a wrapped call runs inside the call (the shipped demo keeps
// its order of emits); while held, wrapped calls wait and run in call order
// at release, a throw in one does not stop the rest; after release, calls
// run at once again.
import { afterEach, describe, expect, it } from "bun:test";
import { held, hold, release } from "./demo-hold.ts";

// release() with nothing held is a no-op, so every case can end with it.
afterEach(() => release());

// Let queued microtasks and one macrotask run.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("demo hold", () => {
  it("runs a call at once, inside the call, when nothing is held", async () => {
    const log: string[] = [];
    const wrapped = held((x: string) => {
      log.push(x);
      return x.length;
    });
    const p = wrapped("abc");
    expect(log).toStrictEqual(["abc"]);
    expect(await p).toBe(3);
  });

  it("lets a sync throw propagate from the call when nothing is held", () => {
    const wrapped = held(() => {
      throw new Error("boom");
    });
    expect(() => wrapped()).toThrow("boom");
  });

  it("queues calls while held and runs them in call order at release", async () => {
    const log: string[] = [];
    const cmd = held((x: string) => {
      log.push(`cmd:${x}`);
    });
    const api = held(async (x: string) => {
      log.push(`api:${x}`);
      return { path: x };
    });
    hold();
    const p1 = cmd("a");
    const p2 = api("b");
    const p3 = cmd("c");
    await settle();
    expect(log).toStrictEqual([]);
    release();
    await Promise.all([p1, p2, p3]);
    expect(log).toStrictEqual(["cmd:a", "api:b", "cmd:c"]);
    expect(await p2).toStrictEqual({ path: "b" });
  });

  it("rejects only the queued call that throws; later queued calls still run", async () => {
    const log: string[] = [];
    const bad = held(() => {
      throw new Error("bad");
    });
    const good = held((x: string) => {
      log.push(x);
    });
    hold();
    const pBad = bad();
    const pGood = good("after");
    release();
    await expect(pBad).rejects.toThrow("bad");
    await pGood;
    expect(log).toStrictEqual(["after"]);
  });

  it("runs calls at once again after release", async () => {
    const log: string[] = [];
    const wrapped = held((x: string) => {
      log.push(x);
    });
    hold();
    const queued = wrapped("queued");
    release();
    await queued;
    wrapped("later");
    expect(log).toStrictEqual(["queued", "later"]);
  });
});
