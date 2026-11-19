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

describe("CODEX_MODELS", () => {
  // Nil, 2026-11-19: the fallback list keeps the two newest generations of
  // each model line. A line is the slug after its version (gpt-6.2-sol is the
  // "sol" line; plain gpt-5.5 is its own line), so an upgrade that adds a
  // third generation must drop the oldest.
  it("keeps at most two generations of each model line", () => {
    const generations = new Map<string, Set<string>>();
    for (const { value } of CODEX_MODELS) {
      const match = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(value);
      expect(match).not.toBeNull();
      const [, version, line = ""] = match!;
      generations.set(line, (generations.get(line) ?? new Set()).add(version));
    }
    const over = [...generations]
      .filter(([, versions]) => versions.size > 2)
      .map(
        ([line, versions]) => `${line || "plain"}: ${[...versions].join(", ")}`,
      );
    expect(over).toEqual([]);
  });
});
