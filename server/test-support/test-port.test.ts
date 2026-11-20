// exclusiveTestPort: the port a test hands to a child or a later bind must be
// one no other process can take first (task 72affd86: a port-0 port was taken
// by another test process, and the entry's GET / reached that process).
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { exclusiveTestPort } from "./test-port.ts";

const min = Number(process.env.ISOMUX_TEST_APP_PORT_MIN);
const max = Number(process.env.ISOMUX_TEST_APP_PORT_MAX);

let held: Bun.TCPSocketListener<undefined>[] = [];

afterEach(() => {
  for (const s of held) s.stop(true);
  held = [];
});

// Holds every port of the block that binds now, except `keep`.
function holdBlockExcept(keep: number | null): void {
  for (let port = min; port <= max; port++) {
    if (port === keep) continue;
    try {
      held.push(
        Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }),
      );
    } catch (error) {
      // Already held in this process (an app of an earlier file): still taken.
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
}

function binds(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(
      true,
    );
    return true;
  } catch {
    return false;
  }
}

describe("exclusiveTestPort", () => {
  it("gives a different free port of this process's block on each call", () => {
    expect(Number.isInteger(min) && Number.isInteger(max)).toBe(true);
    const ports = [
      exclusiveTestPort(),
      exclusiveTestPort(),
      exclusiveTestPort(),
    ];
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(min);
      expect(port).toBeLessThanOrEqual(max);
      expect(binds(port)).toBe(true);
    }
    expect(new Set(ports).size).toBe(3);
  });

  it("skips held ports and comes back round to a port it gave before", () => {
    // `first` is behind the walk after this call, so only a walk that wraps
    // reaches it again.
    const first = exclusiveTestPort();
    holdBlockExcept(first);
    expect(binds(first)).toBe(true);
    expect(exclusiveTestPort()).toBe(first);
  });

  it("throws when every port of the block is held", () => {
    holdBlockExcept(null);
    expect(held.length).toBeGreaterThan(0);
    expect(() => exclusiveTestPort()).toThrow();
  });

  it("throws outside a test process that claimed a block", async () => {
    // No preload, so no ISOMUX_TEST_APP_PORT_MIN/MAX: no fallback port.
    const helper = join(import.meta.dir, "test-port.ts");
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { exclusiveTestPort } from ${JSON.stringify(helper)};
         try { console.log("port " + exclusiveTestPort()); }
         catch { console.log("threw"); }`,
      ],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("threw");
  });
});
