// The OpenCode profile key and the member's Isomux-held files (Lead ruling,
// 2026-10-13): the key hashes the member's env, secrets and MCP servers files
// when they exist, never an office store file, and two members with personal
// MCP servers get two servers whose configs hold only their own servers and
// the office ones.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  environmentSourceKeyForUserId,
  setOfficeEnvFileProvider,
} from "./env-loader.ts";
import { createMcpServerSources, mcpServersForUserId } from "./mcp-servers.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import { openCodeSupervisorForEnvironment } from "./backends/opencode/supervisor.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";

const office = { kind: "office" } as const;
const member = (userId: string) => ({ kind: "user", userId }) as const;

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath("any")), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "mcp-servers"), { recursive: true, force: true });
});

function addServer(
  scope: ReturnType<typeof member> | typeof office,
  name: string,
) {
  const sources = createMcpServerSources();
  expect(
    sources.servers.create(scope, {
      name,
      url: `https://${name}.example.com/mcp`,
      secret: null,
    }).ok,
  ).toBe(true);
}

describe("OpenCode profile key", () => {
  it("changes once for each member file that appears, and never moves back", () => {
    const sources = createMcpServerSources();
    const keys = [environmentSourceKeyForUserId("u1")];
    writeManagedUserEnv("u1", { A: "1" });
    keys.push(environmentSourceKeyForUserId("u1"));
    sources.secrets.create(member("u1"), {
      name: "TOKEN",
      value: "fake-key-test-value",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    });
    keys.push(environmentSourceKeyForUserId("u1"));
    addServer(member("u1"), "docs");
    keys.push(environmentSourceKeyForUserId("u1"));
    expect(new Set(keys).size).toBe(4);

    // Emptied lists keep their files, so the key stays.
    sources.secrets.remove(member("u1"), "TOKEN");
    sources.servers.remove(member("u1"), "docs");
    expect(existsSync(join(STATE_ROOT, "secrets", "users", "u1.json"))).toBe(
      true,
    );
    expect(
      existsSync(join(STATE_ROOT, "mcp-servers", "users", "u1.json")),
    ).toBe(true);
    expect(environmentSourceKeyForUserId("u1")).toBe(keys[3]);
  });

  it("stays the same when an office secrets or MCP servers file appears", () => {
    const before = environmentSourceKeyForUserId("u1");
    const sources = createMcpServerSources();
    sources.secrets.create(office, {
      name: "TOKEN",
      value: "fake-key-test-value",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    });
    addServer(office, "shared");
    expect(environmentSourceKeyForUserId("u1")).toBe(before);
    expect(environmentSourceKeyForUserId(null)).toBe(
      environmentSourceKeyForUserId("u2"),
    );
  });

  for (const withOfficeEnv of [false, true])
    it(`gives two members with personal MCP servers two profiles and their own servers (office env file: ${withOfficeEnv})`, () => {
      if (withOfficeEnv) writeManagedOfficeEnv({ SHARED: "1" });
      // Before: neither has a file of their own, so they share a profile.
      expect(environmentSourceKeyForUserId("u1")).toBe(
        environmentSourceKeyForUserId("u2"),
      );
      addServer(office, "shared");
      addServer(member("u1"), "one");
      addServer(member("u2"), "two");
      const sources = createMcpServerSources();
      const profiles = ["u1", "u2"].map((userId) => {
        const key = environmentSourceKeyForUserId(userId);
        const supervisor = openCodeSupervisorForEnvironment(
          key,
          {},
          "rev",
          mcpServersForUserId(sources, userId),
        );
        return {
          dir: openCodeProfilePaths(key).profileDir,
          supervisorDir: supervisor.profileDir,
          servers: Object.keys(supervisor.configuration.mcp ?? {}).sort(),
        };
      });
      expect(profiles[0].dir).not.toBe(profiles[1].dir);
      expect(profiles.map((p) => p.supervisorDir)).toEqual(
        profiles.map((p) => p.dir),
      );
      expect(profiles.map((p) => p.servers)).toEqual([
        ["isomux-one", "isomux-shared"],
        ["isomux-shared", "isomux-two"],
      ]);
    });
});
