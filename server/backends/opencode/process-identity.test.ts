import { describe, expect, it } from "bun:test";
import {
  linuxProcessIdentityMatches,
  parseLinuxProcessState,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
} from "./process-identity.ts";

describe("Linux process identity", () => {
  it("parses start ticks after a comm containing spaces and close-parens", () => {
    const fields = [
      "S",
      ...Array.from({ length: 18 }, (_, i) => String(i + 1)),
      "424242",
      "23",
    ];
    expect(
      parseLinuxProcessStartTicks(`99 (a) b (c) ${fields.join(" ")}`),
    ).toBe("424242");
    expect(parseLinuxProcessState(`99 (a) b (c) ${fields.join(" ")}`)).toBe(
      "S",
    );
  });

  it("matches both pid and kernel start ticks", () => {
    const ticks = readLinuxProcessStartTicks(process.pid);
    expect(ticks).not.toBeNull();
    expect(linuxProcessIdentityMatches(process.pid, ticks!)).toBe(true);
    expect(linuxProcessIdentityMatches(process.pid, `${ticks}0`)).toBe(false);
    expect(linuxProcessIdentityMatches(process.pid, undefined)).toBe(false);
  });
});
