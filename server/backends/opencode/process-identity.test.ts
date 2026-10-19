import { describe, expect, it } from "bun:test";
import {
  linuxProcessIdentityMatches,
  parseLinuxProcessHop,
  parseLinuxProcessState,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
} from "./process-identity.ts";

describe("Linux process identity", () => {
  it("parses start ticks after a comm containing spaces and close-parens", () => {
    const fields = [
      "S",
      "4321",
      ...Array.from({ length: 17 }, (_, i) => String(i + 2)),
      "424242",
      "23",
    ];
    expect(
      parseLinuxProcessStartTicks(`99 (a) b (c) ${fields.join(" ")}`),
    ).toBe("424242");
    expect(parseLinuxProcessState(`99 (a) b (c) ${fields.join(" ")}`)).toBe(
      "S",
    );
    // The authority broker walks ancestry with this parser.
    expect(
      parseLinuxProcessHop(99, `99 (a) b (c) ${fields.join(" ")}`),
    ).toEqual({ pid: 99, parentPid: 4321, startTicks: "424242" });
  });

  it("matches both pid and kernel start ticks", () => {
    const ticks = readLinuxProcessStartTicks(process.pid);
    expect(ticks).not.toBeNull();
    expect(linuxProcessIdentityMatches(process.pid, ticks!)).toBe(true);
    expect(linuxProcessIdentityMatches(process.pid, `${ticks}0`)).toBe(false);
    expect(linuxProcessIdentityMatches(process.pid, undefined)).toBe(false);
  });
});
