// MCP servers as an engine gets them when a secret proxy runs (secrets B2):
// a real store with a secret and a server, and mcpServersForUserId with a
// placeholder provider like the secrets runtime's. The engine tests check
// that each engine's MCP channel carries the placeholder, never the value.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpServerSources,
  mcpServersForUserId,
  setMcpPlaceholderProvider,
  type AgentMcpServer,
} from "../mcp-servers.ts";
import { placeholderFor, scopeId } from "../secret-proxy/placeholders.ts";

// Obvious fakes.
export const MCP_SECRET_VALUE = "ghp_FAKEmcpFAKEmcpFAKEmcpFAKEmcpFAKEmc01";
const KEY = Buffer.alloc(32, 9);

export function placeholderMcpServers(): {
  servers: AgentMcpServer[];
  placeholder: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mcp-placeholder-"));
  const sources = createMcpServerSources(root);
  const scope = { kind: "user", userId: "u-mcp" } as const;
  sources.secrets.create(scope, {
    name: "DOCS_TOKEN",
    value: MCP_SECRET_VALUE,
    hosts: ["docs.example.com"],
    form: { kind: "authorization" },
  });
  sources.servers.create(scope, {
    name: "docs",
    url: "https://docs.example.com/mcp",
    secret: "DOCS_TOKEN",
  });
  const placeholder = placeholderFor(
    KEY,
    scope,
    "DOCS_TOKEN",
    1,
    MCP_SECRET_VALUE,
  );
  const previous = setMcpPlaceholderProvider((s, name) =>
    scopeId(s) === scopeId(scope) && name === "DOCS_TOKEN" ? placeholder : null,
  );
  try {
    return { servers: mcpServersForUserId(sources, "u-mcp"), placeholder };
  } finally {
    setMcpPlaceholderProvider(previous);
    rmSync(root, { recursive: true, force: true });
  }
}
