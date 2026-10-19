// authSignal is the one place a backend's provider events turn into
// auth_needed. The orchestrator reads the turn's sign-in state when the
// terminal error or turn_completed arrives, so auth_needed must come first.
import { describe, expect, it } from "bun:test";

import { authSignal } from "./auth-signal.ts";
import type { NormalizedEvent } from "./types.ts";

const AUTH = "401 Unauthorized";
const detect = (text: string) => text.includes("401");
const NEEDED: NormalizedEvent = { kind: "auth_needed" };

describe("authSignal", () => {
  const cases: Array<[string, NormalizedEvent, NormalizedEvent[]]> = [
    [
      "replaces auth-shaped provider text",
      { kind: "system_text", text: AUTH },
      [NEEDED],
    ],
    [
      "puts auth_needed before an auth-shaped error",
      { kind: "error", message: AUTH },
      [NEEDED, { kind: "error", message: AUTH }],
    ],
    [
      "puts auth_needed before an auth-shaped failed turn",
      { kind: "turn_completed", status: "failed", error: AUTH },
      [NEEDED, { kind: "turn_completed", status: "failed", error: AUTH }],
    ],
    [
      "passes a provider refusal through: its words are not a sign-in failure",
      {
        kind: "turn_completed",
        status: "failed",
        error: AUTH,
        providerRefusal: true,
      },
      [
        {
          kind: "turn_completed",
          status: "failed",
          error: AUTH,
          providerRefusal: true,
        },
      ],
    ],
    [
      "passes a completed turn through",
      { kind: "turn_completed", status: "completed", error: AUTH },
      [{ kind: "turn_completed", status: "completed", error: AUTH }],
    ],
    [
      "passes other provider text through",
      { kind: "system_text", text: "Provider session initialized." },
      [{ kind: "system_text", text: "Provider session initialized." }],
    ],
    [
      "passes other errors through",
      { kind: "error", message: "ECONNRESET" },
      [{ kind: "error", message: "ECONNRESET" }],
    ],
    [
      "never reads the model's own words",
      { kind: "assistant_text", text: AUTH },
      [{ kind: "assistant_text", text: AUTH }],
    ],
  ];
  for (const [name, ev, expected] of cases)
    it(name, () => {
      expect(authSignal(ev, detect)).toEqual(expected);
    });

  it("keeps auth-shaped text before auth_needed when asked", () => {
    expect(
      authSignal({ kind: "system_text", text: AUTH }, detect, {
        keepText: true,
      }),
    ).toEqual([{ kind: "system_text", text: AUTH }, NEEDED]);
  });

  it("asks the backend's own predicate", () => {
    expect(authSignal({ kind: "error", message: AUTH }, () => false)).toEqual([
      { kind: "error", message: AUTH },
    ]);
  });
});
