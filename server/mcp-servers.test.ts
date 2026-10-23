// The servers an agent gets (server/mcp-servers.ts): precedence, the header
// a secret's form makes, and the fail-closed rules.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createMcpServerSources,
  credentialHeader,
  mcpServerRows,
  mcpServersForUserId,
  setMcpPlaceholderProvider,
} from "./mcp-servers.ts";
import type { SecretScope } from "./secret-store.ts";

// Stands in for the secrets runtime (secrets B2): a placeholder per scope
// and name.
const placeholder = (scope: SecretScope, name: string) =>
  `placeholder-${scope.kind === "office" ? "office" : scope.userId}-${name}`;

const OFFICE_VALUE = "fake-office-mcp-value-0000";
const MEMBER_VALUE = "fake-member-mcp-value-0000";

let root: string;
let warnings: string[];
let warnSpy: ReturnType<typeof spyOn>;
let restorePlaceholders: Parameters<typeof setMcpPlaceholderProvider>[0];

beforeEach(() => {
  restorePlaceholders = setMcpPlaceholderProvider(placeholder);
  root = mkdtempSync(join(tmpdir(), "mcp-servers-"));
  warnings = [];
  warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  setMcpPlaceholderProvider(restorePlaceholders);
  warnSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function seed() {
  const sources = createMcpServerSources(root);
  const office = { kind: "office" } as const;
  const member = { kind: "user", userId: "u1" } as const;
  expect(
    sources.secrets.create(office, {
      name: "OFFICE_TOKEN",
      value: OFFICE_VALUE,
      hosts: ["office.example.com"],
      form: { kind: "authorization" },
    }).ok,
  ).toBe(true);
  expect(
    sources.secrets.create(member, {
      name: "MEMBER_KEY",
      value: MEMBER_VALUE,
      hosts: ["member.example.com"],
      form: { kind: "header", header: "X-Api-Key" },
    }).ok,
  ).toBe(true);
  for (const [scope, body] of [
    [
      office,
      {
        name: "shared",
        url: "https://office.example.com/mcp",
        secret: "OFFICE_TOKEN",
      },
    ],
    [
      office,
      { name: "open", url: "https://open.example.com/mcp", secret: null },
    ],
    [
      member,
      {
        name: "shared",
        url: "https://member.example.com/mcp",
        secret: "MEMBER_KEY",
      },
    ],
  ] as const)
    expect(sources.servers.create(scope, { ...body }).ok).toBe(true);
  return sources;
}

describe("mcpServersForUserId", () => {
  it("gives office servers, a member's own replacing one of the same name, with prefixed names", () => {
    const sources = seed();
    expect(mcpServersForUserId(sources, "u1")).toEqual([
      { name: "isomux-open", url: "https://open.example.com/mcp", headers: {} },
      {
        name: "isomux-shared",
        url: "https://member.example.com/mcp",
        headers: { "x-api-key": "placeholder-u1-MEMBER_KEY" },
      },
    ]);
    expect(mcpServersForUserId(sources, "u2")).toEqual([
      { name: "isomux-open", url: "https://open.example.com/mcp", headers: {} },
      {
        name: "isomux-shared",
        url: "https://office.example.com/mcp",
        headers: { Authorization: "Bearer placeholder-office-OFFICE_TOKEN" },
      },
    ]);
    expect(mcpServersForUserId(sources, null)).toHaveLength(2);
  });

  it("leaves out a server with a secret while no secret proxy listens", () => {
    const sources = seed();
    setMcpPlaceholderProvider(() => null);
    expect(mcpServersForUserId(sources, "u1")).toEqual([
      { name: "isomux-open", url: "https://open.example.com/mcp", headers: {} },
    ]);
    expect(warnings.join("\n")).toContain("isomux-shared".slice(7));
    expect(warnings.join("\n")).not.toContain(OFFICE_VALUE);
  });

  it("leaves out a server whose secret is gone or no longer lists the host", () => {
    const sources = seed();
    sources.secrets.update({ kind: "office" }, "OFFICE_TOKEN", {
      hosts: ["elsewhere.example.com"],
    });
    sources.secrets.remove({ kind: "user", userId: "u1" }, "MEMBER_KEY");
    expect(mcpServersForUserId(sources, "u1").map((s) => s.name)).toEqual([
      "isomux-open",
    ]);
    expect(mcpServersForUserId(sources, "u2").map((s) => s.name)).toEqual([
      "isomux-open",
    ]);
    // Each left-out server is named in a warning, its host never.
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.includes("shared"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("example.com");
  });

  it("fails closed and quiet on an unreadable servers file", () => {
    const sources = seed();
    writeFileSync(join(root, "mcp-servers", "office.json"), "{not json");
    expect(mcpServersForUserId(sources, "u1").map((s) => s.name)).toEqual([
      "isomux-shared",
    ]);
    writeFileSync(join(root, "mcp-servers", "users", "u1.json"), "[]");
    expect(mcpServersForUserId(sources, "u1")).toEqual([]);
    expect(warnings.some((w) => w.includes("could not be read"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("{not json");
  });

  it("fails closed and quiet on an unreadable secrets file", () => {
    const sources = seed();
    writeFileSync(join(root, "secrets", "office.json"), "{not json");
    expect(mcpServersForUserId(sources, "u2").map((s) => s.name)).toEqual([
      "isomux-open",
    ]);
    expect(
      warnings.some((w) => w.includes("secrets file could not be read")),
    ).toBe(true);
  });

  it("gives no server, without a throw, when the state directory cannot be read at all", () => {
    mkdirSync(join(root, "mcp-servers"), { recursive: true });
    writeFileSync(
      join(root, "mcp-servers", "users"),
      "a file, not a directory",
    );
    const sources = createMcpServerSources(root);
    expect(mcpServersForUserId(sources, "u1")).toEqual([]);
  });
});

describe("credentialHeader", () => {
  it("sends the authorization form as a Bearer token and a header form as itself", () => {
    expect(credentialHeader({ kind: "authorization" }, "t")).toEqual({
      Authorization: "Bearer t",
    });
    // A value with its own scheme, as a Fly token has, keeps it.
    expect(
      credentialHeader({ kind: "authorization" }, "FlyV1 fm2_fake"),
    ).toEqual({ Authorization: "FlyV1 fm2_fake" });
    expect(credentialHeader({ kind: "header", header: "x-key" }, "t")).toEqual({
      "x-key": "t",
    });
  });
});

describe("mcpServerRows", () => {
  it("lists hosts only, and an office secret's name for an owner only", () => {
    const sources = seed();
    const rows = mcpServerRows(sources, "u1", false);
    expect(JSON.stringify(rows)).not.toContain("/mcp");
    expect(JSON.stringify(rows)).not.toContain(OFFICE_VALUE);
    expect(
      rows.map((r) => [r.scope, r.name, r.host, r.secret, r.overridden]),
    ).toEqual([
      ["office", "open", "open.example.com", null, false],
      ["office", "shared", "office.example.com", null, true],
      ["personal", "shared", "member.example.com", "MEMBER_KEY", false],
    ]);
    expect(mcpServerRows(sources, "u2", true).map((r) => r.secret)).toEqual([
      null,
      "OFFICE_TOKEN",
    ]);
  });
});
