// A removed member's MCP servers are kept without their sign-ins (task
// 321e7b8e): the archive keeps name, URL, secret name and note, and resets
// each OAuth registration so the member signs in again after a restore.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpServerStore,
  type StoredMcpServer,
} from "./mcp-server-store.ts";
import type { SecretScope } from "./secret-store.ts";

const MIA: SecretScope = { kind: "user", userId: "u-mia" };
const BOB: SecretScope = { kind: "user", userId: "u-bob" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), "isomux-mcp-archive-"));
  roots.push(root);
  // Every secret exists and allows the server's host.
  return createMcpServerStore(() => ["mcp.example.com"], root);
}

const discovery = {
  tokenEndpointAuth: "client_secret_post" as const,
  issuer: "https://mcp.example.com",
  authorizationEndpoint: "https://mcp.example.com/authorize",
  tokenEndpoint: "https://mcp.example.com/token",
  scope: "read",
};

// A client the flow registered on its own, signed in.
const registered = {
  clientId: "registered-client",
  pasted: false,
  clientSecret: "MCP_CLIENT_LINEAR",
  redirectUri: "https://office.example.com/api/mcp-oauth/callback",
  refreshToken: "MCP_REFRESH_LINEAR",
  ownedSecrets: ["MCP_CLIENT_LINEAR", "MCP_REFRESH_LINEAR"],
  ...discovery,
};

// A client the member pasted, signed in. Its client secret is the member's.
const pasted = {
  clientId: "pasted-client",
  pasted: true,
  clientSecret: "NOTION_CLIENT_SECRET",
  redirectUri: null,
  refreshToken: "MCP_REFRESH_NOTION",
  ownedSecrets: ["MCP_REFRESH_NOTION"],
  ...discovery,
};

function seed() {
  const s = store();
  for (const [scope, input, oauth] of [
    [
      MIA,
      {
        name: "plain",
        url: "https://mcp.example.com/plain",
        secret: "PLAIN_TOKEN",
        note: "Read-only.",
      },
      undefined,
    ],
    [
      MIA,
      { name: "linear", url: "https://mcp.example.com/linear" },
      registered,
    ],
    [MIA, { name: "notion", url: "https://mcp.example.com/notion" }, pasted],
    [BOB, { name: "bobs", url: "https://mcp.example.com/bob" }, undefined],
  ] as const) {
    const change = s.create(scope, input, oauth);
    if (!change.ok) throw new Error(`seed ${input.name}: ${change.kind}`);
  }
  return s;
}

const byName = (servers: StoredMcpServer[], name: string) =>
  servers.find((server) => server.name === name)!;

describe("the MCP servers of a removed member", () => {
  it("keep name, URL, secret name and note; each sign-in is reset and its secrets are named for leaving out", () => {
    const s = seed();
    const { servers, ownedSecrets } = s.exportForArchive("u-mia");
    expect(servers.map((server) => server.name).sort()).toEqual([
      "linear",
      "notion",
      "plain",
    ]);
    expect(byName(servers, "plain")).toMatchObject({
      url: "https://mcp.example.com/plain",
      secret: "PLAIN_TOKEN",
      note: "Read-only.",
    });
    expect(byName(servers, "plain").oauth).toBeUndefined();
    // A registered client registers again: nothing of the old one is kept.
    expect(byName(servers, "linear").oauth).toEqual({
      ...registered,
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      refreshToken: null,
      ownedSecrets: [],
    });
    // A pasted client keeps its id and its client secret's NAME.
    expect(byName(servers, "notion").oauth).toEqual({
      ...pasted,
      refreshToken: null,
      ownedSecrets: [],
    });
    expect(ownedSecrets.sort()).toEqual(
      ["MCP_CLIENT_LINEAR", "MCP_REFRESH_LINEAR", "MCP_REFRESH_NOTION"].sort(),
    );
  });

  it("come back as archived, and the other member's stay as they were", () => {
    const s = seed();
    const { servers } = s.exportForArchive("u-mia");
    s.removeMember("u-mia");
    expect(s.list(MIA)).toEqual([]);
    s.importFromArchive("u-mia", servers);
    expect(
      s
        .list(MIA)
        .map((server) => server.name)
        .sort(),
    ).toEqual(["linear", "notion", "plain"]);
    expect(s.oauthOf(MIA, "linear")?.oauth.refreshToken).toBeNull();
    expect(s.oauthOwnedSecrets(MIA)).toEqual([]);
    expect(s.list(BOB).map((server) => server.name)).toEqual(["bobs"]);
  });

  it("a member with no servers archives none", () => {
    expect(store().exportForArchive("u-mia")).toEqual({
      servers: [],
      ownedSecrets: [],
    });
  });
});
