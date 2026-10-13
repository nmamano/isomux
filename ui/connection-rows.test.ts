import { describe, expect, it } from "bun:test";
import {
  CLAUDE_CONNECTORS_URL,
  connectionRows,
  signInSelector,
  variablesSelector,
} from "./connection-rows.ts";
import type { ConnectionsListRes } from "../shared/contract-shapes.ts";

const list: ConnectionsListRes = {
  variables: [
    { scope: "personal", name: "MINE" },
    { scope: "office", name: "GH_TOKEN" },
  ],
  signIns: [
    { scope: "personal", engine: "claude", account: null },
    { scope: "office", engine: "codex", account: "team@example.com" },
  ],
  claudeConnectors: [
    { scope: "office", seenAt: 10, names: ["Gmail", "Drive"] },
    { scope: "personal", seenAt: null, names: [] },
  ],
};

describe("connectionRows", () => {
  it("orders office before the caller's own, sign-ins before connectors before variables", () => {
    expect(
      connectionRows(list, "Ann Lee").map((row) => [row.kind, row.scope]),
    ).toEqual([
      ["signIn", "office"],
      ["connectors", "office"],
      ["variable", "office"],
      ["signIn", "personal"],
      ["connectorsPending", "personal"],
      ["variable", "personal"],
    ]);
  });

  it("points each row at the place where it is set", () => {
    const rows = connectionRows(list, "Ann Lee");
    const where = Object.fromEntries(rows.map((row) => [row.key, row.where]));
    expect(where["variable:personal:MINE"]).toEqual({
      kind: "page",
      half: "personal",
      place: "variables",
      selector: '[data-managed-env-path="/api/users/Ann%20Lee/env"]',
    });
    expect(where["variable:office:GH_TOKEN"]).toMatchObject({
      half: "office",
      selector: variablesSelector("office", "Ann Lee"),
    });
    expect(where["signIn:office:codex"]).toEqual({
      kind: "page",
      half: "office",
      place: "signIn",
      engine: "codex",
      selector: signInSelector("codex"),
    });
    for (const key of ["connectors:office", "connectorsPending:personal"])
      expect(where[key]).toEqual({
        kind: "claude",
        url: CLAUDE_CONNECTORS_URL,
      });
  });

  it("lists a sign-in's connectors in one row", () => {
    expect(
      connectionRows(list, "Ann").find((row) => row.kind === "connectors"),
    ).toMatchObject({ scope: "office", names: ["Gmail", "Drive"] });
  });

  it("tells a sign-in with no turn seen from one that has no connectors", () => {
    const seenEmpty = connectionRows(
      {
        ...list,
        claudeConnectors: [{ scope: "personal", seenAt: 5, names: [] }],
      },
      "Ann",
    );
    expect(seenEmpty.some((row) => row.kind.startsWith("connector"))).toBe(
      false,
    );
    expect(
      connectionRows(list, "Ann").filter(
        (row) => row.kind === "connectorsPending",
      ),
    ).toHaveLength(1);
  });
});
