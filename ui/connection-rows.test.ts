import { describe, expect, it } from "bun:test";
import { normalizeConnectionsList } from "./connection-rows.ts";

// What the Integrations page reads from GET /api/me/connections. An older
// server or a stub answers with another shape; each field of the wrong shape
// costs only its own rows.
describe("normalizeConnectionsList", () => {
  it("refuses an answer without the A1 fields", () => {
    expect(normalizeConnectionsList({})).toBeNull();
    expect(normalizeConnectionsList(null)).toBeNull();
    expect(normalizeConnectionsList({ variables: [], signIns: [] })).toBeNull();
  });

  it("reads an A1 answer with no MCP or secret fields as empty lists", () => {
    expect(
      normalizeConnectionsList({
        variables: [{ scope: "office", name: "GH_TOKEN" }],
        signIns: [],
        claudeConnectors: [{ scope: "office", seenAt: 1, names: ["Gmail"] }],
      }),
    ).toEqual({
      variables: [{ scope: "office", name: "GH_TOKEN" }],
      signIns: [],
      claudeConnectors: [
        { scope: "office", seenAt: 1, names: ["Gmail"], statuses: [] },
      ],
      mcpServers: [],
      engineMcpServers: [],
      secrets: [],
    });
  });

  it("drops a field of another shape, and only that field", () => {
    const list = normalizeConnectionsList({
      variables: [{ scope: "office", name: "GH_TOKEN" }],
      signIns: [],
      claudeConnectors: [
        {
          scope: "office",
          seenAt: 1,
          names: ["Gmail", "Drive"],
          statuses: [
            { name: "Gmail", status: "connected" },
            { name: "Drive", status: "exploded" },
          ],
        },
      ],
      mcpServers: "nope",
      engineMcpServers: [
        {
          engine: "claude",
          name: "x",
          source: "user",
          folder: null,
          status: "odd",
        },
      ],
      secrets: [
        {
          scope: "office",
          name: "A",
          hosts: ["a.example.com"],
          test: "github",
        },
        { scope: "office", name: "B", hosts: ["b.example.com"], test: "nope" },
        { scope: "office", name: 7, hosts: [] },
      ],
    })!;
    expect(list.variables).toHaveLength(1);
    expect(list.mcpServers).toEqual([]);
    // An unknown status reads as none read yet.
    expect(list.claudeConnectors[0].statuses).toEqual([
      { name: "Gmail", status: "connected" },
    ]);
    expect(list.engineMcpServers[0].status).toBeNull();
    expect(list.secrets!.map((s) => [s.name, s.test])).toEqual([
      ["A", "github"],
      ["B", null],
    ]);
  });
});
