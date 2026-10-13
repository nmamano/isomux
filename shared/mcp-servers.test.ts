import { describe, expect, it } from "bun:test";
import {
  checkMcpServerName,
  checkMcpServerUrl,
  mcpEngineName,
  mcpServerHost,
} from "./mcp-servers.ts";

describe("MCP server fields", () => {
  it("gives every engine name the reserved prefix", () => {
    expect(mcpEngineName("linear")).toBe("isomux-linear");
  });

  it("takes lowercase names up to 24 characters with inner hyphens", () => {
    expect(checkMcpServerName("linear")).toBe(null);
    expect(checkMcpServerName("a-b-2")).toBe(null);
    expect(checkMcpServerName("x".repeat(24))).toBe(null);
    expect(checkMcpServerName("x".repeat(25))?.reason).toBe("too_long");
    for (const bad of ["", "Linear", "-a", "a-", "a_b", "a b", 7, null])
      expect(checkMcpServerName(bad)?.reason).toBe("invalid");
  });

  it("takes https to any host, and http only to this machine with no credential", () => {
    const ok = (url: string, credential = false) =>
      checkMcpServerUrl(url, credential).ok;
    expect(ok("https://mcp.example.com/mcp", true)).toBe(true);
    expect(ok("http://localhost:8123/mcp")).toBe(true);
    expect(ok("http://127.0.0.1/mcp")).toBe(true);
    expect(ok("http://[::1]:9/mcp")).toBe(true);
    expect(ok("http://mcp.example.com/mcp")).toBe(false);
    expect(ok("http://localhost:8123/mcp", true)).toBe(false);
    expect(ok("https://user:pass@mcp.example.com/")).toBe(false);
    expect(ok("https://mcp.example.com/#frag")).toBe(false);
    expect(ok(" https://mcp.example.com/")).toBe(false);
    expect(ok("wss://mcp.example.com/")).toBe(false);
    expect(ok(`https://mcp.example.com/${"a".repeat(2048)}`)).toBe(false);
  });

  it("refuses a port other than 443 with a credential, which the secrets proxy would not serve", () => {
    expect(checkMcpServerUrl("https://mcp.example.com:8443/mcp", true)).toEqual(
      {
        ok: false,
        error: { field: "url", reason: "credential_port" },
      },
    );
    // URL drops the default port, so an explicit :443 is the same URL.
    expect(checkMcpServerUrl("https://mcp.example.com:443/mcp", true)).toEqual({
      ok: true,
      url: "https://mcp.example.com/mcp",
      host: "mcp.example.com",
    });
    expect(
      checkMcpServerUrl("https://mcp.example.com:8443/mcp", false).ok,
    ).toBe(true);
  });

  it("names the host of a URL, and nothing for a bad one", () => {
    expect(mcpServerHost("https://mcp.example.com/secret/path")).toBe(
      "mcp.example.com",
    );
    expect(mcpServerHost("not a url")).toBe("");
  });
});
