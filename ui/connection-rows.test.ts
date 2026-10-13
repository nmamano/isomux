import { describe, expect, it } from "bun:test";
import {
  CLAUDE_CONNECTORS_URL,
  mcpServersSelector,
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
  mcpServers: [],
  engineMcpServers: [],
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

describe("connectionRows: MCP servers", () => {
  const withServers: ConnectionsListRes = {
    ...list,
    mcpServers: [
      {
        scope: "office",
        name: "linear",
        host: "mcp.linear.app",
        credential: true,
        secret: null,
        problem: null,
        overridden: true,
      },
      {
        scope: "personal",
        name: "linear",
        host: "mcp.example.com",
        credential: false,
        secret: null,
        problem: null,
        overridden: false,
      },
    ],
    engineMcpServers: [
      { engine: "claude", name: "notes", source: "user", folder: null },
      { engine: "claude", name: "repo", source: "project", folder: "/w/app" },
    ],
  };

  it("puts Isomux servers after connectors in their scope, and Claude's own with the caller's", () => {
    expect(
      connectionRows(withServers, "Ann Lee").map((row) => [
        row.kind,
        row.scope,
      ]),
    ).toEqual([
      ["signIn", "office"],
      ["connectors", "office"],
      ["mcpServer", "office"],
      ["variable", "office"],
      ["signIn", "personal"],
      ["connectorsPending", "personal"],
      ["mcpServer", "personal"],
      ["engineMcp", "personal"],
      ["engineMcp", "personal"],
      ["variable", "personal"],
    ]);
  });

  it("points an Isomux server at its editor and Claude's own at Claude's files", () => {
    const rows = connectionRows(withServers, "Ann Lee");
    const where = Object.fromEntries(rows.map((row) => [row.key, row.where]));
    expect(where["mcpServer:personal:linear"]).toEqual({
      kind: "page",
      half: "personal",
      place: "mcpServers",
      selector: mcpServersSelector("personal", "Ann Lee"),
    });
    expect(mcpServersSelector("personal", "Ann Lee")).toBe(
      '[data-mcp-servers-path="/api/users/Ann%20Lee/mcp-servers"]',
    );
    expect(where["engineMcp:project:/w/app:repo"]).toEqual({
      kind: "claudeFile",
      source: "project",
      folder: "/w/app",
    });
    expect(where["engineMcp:user::notes"]).toEqual({
      kind: "claudeFile",
      source: "user",
      folder: null,
    });
  });
});
