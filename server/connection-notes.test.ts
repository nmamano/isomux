// Usage notes on connections (integrations A4): the note rule, the stores'
// backward-compatible reads, and that a note change restarts and re-registers
// nothing (the OpenCode profile key and revision, and the MCP servers the
// engines get, stay the same).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import { isCredentialStorePath } from "./credential-store-paths.ts";
import {
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
  setOfficeEnvFileProvider,
} from "./env-loader.ts";
import {
  createMcpServerSources,
  mcpServersForUserId,
  setMcpPlaceholderProvider,
} from "./mcp-servers.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvNotesPath,
  managedUserEnvPath,
  readManagedOfficeEnvNotes,
  readManagedUserEnvNotes,
  removeManagedUserEnv,
  writeManagedOfficeEnv,
  writeManagedOfficeEnvNotes,
  writeManagedUserEnv,
  writeManagedUserEnvNotes,
} from "./user-env.ts";
import {
  CONNECTION_NOTE_MAX_LENGTH,
  checkConnectionNote,
} from "../shared/connection-notes.ts";

const office = { kind: "office" } as const;
const member = { kind: "user", userId: "notes-u1" } as const;

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath("any")), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "mcp-servers"), { recursive: true, force: true });
});

const afterEachRestores: (() => void)[] = [];
afterEach(() => {
  for (const restore of afterEachRestores.splice(0)) restore();
});

describe("the note rule", () => {
  it("trims, clears on empty, keeps newline and tab, and refuses other control characters and over-long text", () => {
    expect(checkConnectionNote(null)).toEqual({ ok: true, note: null });
    expect(checkConnectionNote("   ")).toEqual({ ok: true, note: null });
    expect(checkConnectionNote(" a\n\tb ")).toEqual({
      ok: true,
      note: "a\n\tb",
    });
    expect(checkConnectionNote("a\rb")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(checkConnectionNote(42)).toEqual({ ok: false, reason: "invalid" });
    expect(checkConnectionNote("x".repeat(CONNECTION_NOTE_MAX_LENGTH)).ok).toBe(
      true,
    );
    expect(
      checkConnectionNote("x".repeat(CONNECTION_NOTE_MAX_LENGTH + 1)),
    ).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("stored notes", () => {
  it("reads a secrets or MCP servers file whose note breaks today's rule, and one with no note", () => {
    const long = "x".repeat(CONNECTION_NOTE_MAX_LENGTH + 50);
    const secretsFile = join(STATE_ROOT, "secrets", "office.json");
    mkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
    const secret = {
      value: "fake-notes-secret-value",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
      generation: 1,
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
    };
    writeFileSync(
      secretsFile,
      JSON.stringify({
        version: 1,
        secrets: [
          { name: "OLD", ...secret },
          { name: "LONG", ...secret, note: long },
        ],
      }),
    );
    const serversFile = join(STATE_ROOT, "mcp-servers", "office.json");
    mkdirSync(dirname(serversFile), { recursive: true, mode: 0o700 });
    const server = { secret: null, createdAt: 1, updatedAt: 1 };
    writeFileSync(
      serversFile,
      JSON.stringify({
        version: 1,
        servers: [
          { name: "old", url: "https://old.example.com/mcp", ...server },
          {
            name: "long",
            url: "https://long.example.com/mcp",
            ...server,
            note: `a\u0000${long}`,
          },
        ],
      }),
    );
    const sources = createMcpServerSources();
    expect(
      sources.secrets.list(office).map((s) => [s.name, s.note?.length ?? null]),
    ).toEqual([
      ["OLD", null],
      ["LONG", long.length],
    ]);
    expect(
      sources.servers.list(office).map((s) => [s.name, s.note?.length ?? null]),
    ).toEqual([
      ["old", null],
      ["long", long.length + 2],
    ]);
  });

  it("refuses a bad note at write, on create and update", () => {
    const sources = createMcpServerSources();
    const long = "x".repeat(CONNECTION_NOTE_MAX_LENGTH + 1);
    expect(
      sources.secrets.create(member, {
        name: "TOKEN",
        value: "fake-notes-secret-value",
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
        note: long,
      }),
    ).toEqual({
      ok: false,
      kind: "invalid",
      error: { field: "note", reason: "too_long" },
    });
    expect(
      sources.servers.create(member, {
        name: "docs",
        url: "https://docs.example.com/mcp",
        secret: null,
        note: "a\u0007",
      }),
    ).toEqual({
      ok: false,
      kind: "invalid",
      error: { field: "note", reason: "invalid" },
    });
    expect(
      sources.servers.create(member, {
        name: "docs",
        url: "https://docs.example.com/mcp",
        secret: null,
      }).ok,
    ).toBe(true);
    expect(sources.servers.update(member, "docs", { note: long })).toEqual({
      ok: false,
      kind: "invalid",
      error: { field: "note", reason: "too_long" },
    });
  });

  it("changes no MCP server an engine gets when a note changes", () => {
    // Stands in for the secrets proxy (B2): with no placeholder, a server
    // whose credential is a secret is left out.
    const restore = setMcpPlaceholderProvider(
      (_scope, name) => `placeholder-${name}`,
    );
    afterEachRestores.push(() => setMcpPlaceholderProvider(restore));
    const sources = createMcpServerSources();
    expect(
      sources.secrets.create(member, {
        name: "TOKEN",
        value: "fake-notes-secret-value",
        hosts: ["docs.example.com"],
        form: { kind: "authorization" },
      }).ok,
    ).toBe(true);
    expect(
      sources.servers.create(member, {
        name: "docs",
        url: "https://docs.example.com/mcp",
        secret: "TOKEN",
      }).ok,
    ).toBe(true);
    const before = mcpServersForUserId(sources, member.userId);
    expect(before).toHaveLength(1);
    expect(
      sources.servers.update(member, "docs", { note: "read only" }).ok,
    ).toBe(true);
    expect(
      sources.secrets.update(member, "TOKEN", { note: "for docs" }).ok,
    ).toBe(true);
    expect(mcpServersForUserId(sources, member.userId)).toEqual(before);
  });
});

describe("variable notes", () => {
  it("keep the OpenCode profile key and revision when only a note changes", () => {
    writeManagedOfficeEnv({ OFFICE: "1" });
    writeManagedUserEnv(member.userId, { MINE: "1" });
    const key = environmentSourceKeyForUserId(member.userId);
    const revision = environmentSourceRevisionForUserId(member.userId);
    writeManagedUserEnvNotes(member.userId, { MINE: "use for docs" });
    writeManagedOfficeEnvNotes({ OFFICE: "office only" });
    expect(readManagedUserEnvNotes(member.userId)).toEqual({
      MINE: "use for docs",
    });
    expect(readManagedOfficeEnvNotes()).toEqual({ OFFICE: "office only" });
    expect(environmentSourceKeyForUserId(member.userId)).toBe(key);
    expect(environmentSourceRevisionForUserId(member.userId)).toBe(revision);
  });

  it("show only on the names in the .env file, and a sidecar that does not parse reads as none", () => {
    writeManagedUserEnv(member.userId, { MINE: "1" });
    writeManagedUserEnvNotes(member.userId, { MINE: "a", GONE: "b" });
    expect(readManagedUserEnvNotes(member.userId)).toEqual({ MINE: "a" });
    writeFileSync(managedUserEnvNotesPath(member.userId), "{not json");
    expect(readManagedUserEnvNotes(member.userId)).toEqual({});
  });

  it("live in the credential store dirs, and go with the member's env", () => {
    writeManagedUserEnv(member.userId, { MINE: "1" });
    writeManagedUserEnvNotes(member.userId, { MINE: "a" });
    expect(isCredentialStorePath(managedUserEnvNotesPath(member.userId))).toBe(
      true,
    );
    expect(
      isCredentialStorePath(
        join(dirname(managedOfficeEnvPath()), "office.notes.json"),
      ),
    ).toBe(true);
    removeManagedUserEnv(member.userId);
    writeManagedUserEnv(member.userId, { MINE: "1" });
    expect(readManagedUserEnvNotes(member.userId)).toEqual({});
  });
});
