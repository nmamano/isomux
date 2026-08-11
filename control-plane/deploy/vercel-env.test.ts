// What may be written, and what may be said about it afterwards.
//
// The canaries are shaped like the real values and published here, so a leak of
// one is an observation rather than an incident.

import { describe, expect, test } from "bun:test";
import { FORBIDDEN_ENV_NAMES } from "./vercel-api.ts";
import { factOf, judgeInventory } from "./vercel-env.ts";
import type { EnvWrite } from "./vercel-env.ts";

const CANARY_DSN = "postgresql://canary-role:canary-pw@canary-host/canary-db";
const CANARY_SECRET = "isomuxD3PublicCanarySecret0123456789abcd";

const PREVIEW: EnvWrite[] = [
  {
    key: "CONTROL_PLANE_DB",
    value: CANARY_DSN,
    type: "sensitive",
    target: ["preview"],
  },
  {
    key: "AUTH_SECRET",
    value: CANARY_SECRET,
    type: "sensitive",
    target: ["preview"],
  },
];

const fact = (key: string, type = "sensitive", target = ["preview"]) => ({
  key,
  type,
  target,
});

describe("what survives a response", () => {
  test("A VALUE CANNOT SURVIVE, WHATEVER VERCEL CALLS IT", () => {
    // Every shape a value could come back in: the documented field, a masked
    // placeholder, and a field nobody designed. None of them is on the
    // allowlist, so none of them exists after this call.
    const row = {
      key: "AUTH_SECRET",
      type: "sensitive",
      target: ["preview"],
      value: CANARY_SECRET,
      decrypted: CANARY_SECRET,
      valuePreview: CANARY_SECRET.slice(0, 6),
      somethingNew: CANARY_DSN,
    };
    const kept = factOf(row);
    expect(kept).toEqual(fact("AUTH_SECRET"));
    const serialised = JSON.stringify(kept);
    for (const secret of [
      CANARY_SECRET,
      CANARY_DSN,
      CANARY_SECRET.slice(0, 6),
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  test("a missing or oddly-typed field becomes empty, not undefined text", () => {
    expect(factOf({})).toEqual({ key: "", type: "", target: [] });
    expect(factOf({ key: 7, type: null, target: "preview" })).toEqual({
      key: "",
      type: "",
      target: ["preview"],
    });
  });
});

describe("is the project carrying exactly what was intended", () => {
  test("the approved Preview pair is exact", () => {
    const verdict = judgeInventory(
      [fact("CONTROL_PLANE_DB"), fact("AUTH_SECRET")],
      PREVIEW,
      FORBIDDEN_ENV_NAMES,
    );
    expect(verdict.exact).toBe(true);
    expect(verdict.forbiddenPresent).toEqual([]);
  });

  test("EVERY WAY IT COULD BE WRONG IS REPORTED SEPARATELY", () => {
    const missing = judgeInventory(
      [fact("CONTROL_PLANE_DB")],
      PREVIEW,
      FORBIDDEN_ENV_NAMES,
    );
    expect({ exact: missing.exact, missing: missing.missing }).toEqual({
      exact: false,
      missing: ["AUTH_SECRET"],
    });

    const extra = judgeInventory(
      [fact("CONTROL_PLANE_DB"), fact("AUTH_SECRET"), fact("AUTH_URL")],
      PREVIEW,
      FORBIDDEN_ENV_NAMES,
    );
    expect({ exact: extra.exact, unexpected: extra.unexpected }).toEqual({
      exact: false,
      unexpected: ["AUTH_URL"],
    });

    // The right name, stored readable. This is the one that matters most:
    // it would look completely normal in a listing.
    const readable = judgeInventory(
      [fact("CONTROL_PLANE_DB", "encrypted"), fact("AUTH_SECRET")],
      PREVIEW,
      FORBIDDEN_ENV_NAMES,
    );
    expect({ exact: readable.exact, wrongType: readable.wrongType }).toEqual({
      exact: false,
      wrongType: ["CONTROL_PLANE_DB"],
    });

    // The right name in the WRONG ENVIRONMENT - a preview database reachable
    // from production, or the reverse.
    const scoped = judgeInventory(
      [
        fact("CONTROL_PLANE_DB", "sensitive", ["production"]),
        fact("AUTH_SECRET"),
      ],
      PREVIEW,
      FORBIDDEN_ENV_NAMES,
    );
    expect({ exact: scoped.exact, wrongTarget: scoped.wrongTarget }).toEqual({
      exact: false,
      wrongTarget: ["CONTROL_PLANE_DB"],
    });
  });

  test("A FORBIDDEN NAME IS CALLED OUT BY NAME, one at a time", () => {
    for (const name of FORBIDDEN_ENV_NAMES) {
      const verdict = judgeInventory(
        [fact("CONTROL_PLANE_DB"), fact("AUTH_SECRET"), fact(name)],
        PREVIEW,
        FORBIDDEN_ENV_NAMES,
      );
      expect({ name, present: verdict.forbiddenPresent }).toEqual({
        name,
        present: [name],
      });
      expect(verdict.exact).toBe(false);
    }
  });

  test("no verdict field can carry a value, because none of them holds one", () => {
    const verdict = judgeInventory([], PREVIEW, FORBIDDEN_ENV_NAMES);
    const serialised = JSON.stringify(verdict);
    expect(serialised).not.toContain(CANARY_SECRET);
    expect(serialised).not.toContain(CANARY_DSN);
  });
});
