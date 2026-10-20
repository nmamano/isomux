import { describe, it, expect } from "bun:test";
import {
  CODEX_MODELS,
  codexDefaultModel,
  type BackendModelWire,
} from "./types.ts";

const model = (
  id: string,
  flags: { isDefault?: boolean; hidden?: boolean } = {},
): BackendModelWire => ({ id, label: id, supportedEfforts: [], ...flags });

const FALLBACK = CODEX_MODELS[0].value;

describe("codexDefaultModel", () => {
  // The rule a new Codex agent's model follows on the server and in the
  // pickers: the login's visible isDefault, then CODEX_MODELS[0] if the login
  // lists it, then the first visible model. A hidden model is never chosen,
  // because the login cannot pick it.
  const cases: [string, BackendModelWire[], string | undefined][] = [
    [
      "the login's default beats an earlier static default",
      [
        model("gpt-a"),
        model(FALLBACK),
        model("gpt-login", { isDefault: true }),
      ],
      "gpt-login",
    ],
    [
      "a hidden isDefault is skipped for the static default",
      [
        model("gpt-a"),
        model("gpt-hidden", { isDefault: true, hidden: true }),
        model(FALLBACK),
      ],
      FALLBACK,
    ],
    [
      "no default reported: the static default when listed",
      [model("gpt-a"), model(FALLBACK)],
      FALLBACK,
    ],
    [
      "the static default hidden: the first visible model",
      [model(FALLBACK, { hidden: true }), model("gpt-a"), model("gpt-b")],
      "gpt-a",
    ],
    ["an empty list", [], undefined],
    [
      "only hidden models",
      [model(FALLBACK, { hidden: true }), model("gpt-a", { hidden: true })],
      undefined,
    ],
  ];
  for (const [name, models, expected] of cases) {
    it(name, () => {
      expect(codexDefaultModel(models)).toBe(expected);
    });
  }
});
