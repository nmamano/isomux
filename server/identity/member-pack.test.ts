// memberPackLimits (task 134b8f77, part 2): the limits of an identity of a
// member with a permission pack. The wiring into every identity of the member
// is server/test-support/member-pack.test.ts.

import { describe, expect, it } from "bun:test";
import { memberPackLimits } from "./member-pack.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";

const pack: MemberPack = {
  areas: { agents: "write", tasks: "read" },
  agentCeiling: "office",
};

describe("memberPackLimits", () => {
  it("leaves the limits of a member without a pack as they are", () => {
    expect(memberPackLimits(undefined, undefined)).toBeUndefined();
    const limits = { areas: { tasks: "write" as const }, rooms: ["r1"] };
    expect(memberPackLimits(limits, undefined)).toEqual(limits);
  });

  it("gives an identity without limits the pack's areas, never full access", () => {
    expect(memberPackLimits(undefined, pack)).toEqual({ areas: pack.areas });
  });

  it("cuts each area to the pack's level and keeps rooms and replies only", () => {
    expect(
      memberPackLimits(
        {
          areas: { agents: "write", tasks: "write", memory: "read" },
          rooms: ["r1"],
          repliesOnly: true,
        },
        pack,
      ),
    ).toEqual({
      areas: { agents: "write", tasks: "read" },
      rooms: ["r1"],
      repliesOnly: true,
    });
  });

  it("gives a rooms-only token (every area) the pack's areas, with its rooms", () => {
    expect(memberPackLimits({ rooms: ["r1"] }, pack)).toEqual({
      areas: pack.areas,
      rooms: ["r1"],
    });
  });
});
