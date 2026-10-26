// The OpenCode profile key (task df0e7b51): it belongs to the owner, so no env,
// secrets or MCP servers file that appears or goes moves it, and two members
// never share a profile. Two members with personal MCP servers get two
// servers whose configs hold only their own servers and the office ones.

import { afterEach, describe, expect, it } from "bun:test";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  environmentSourceKeyForUserId,
  legacyEnvironmentSourceKeyForUserId,
  setOfficeEnvFileProvider,
} from "./env-loader.ts";
import { migrateProfileKeysOnce } from "./opencode-profile-keys.ts";
import { createMcpServerSources, mcpServersForUserId } from "./mcp-servers.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import { openCodeSupervisorForEnvironment } from "./backends/opencode/supervisor.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

const office = { kind: "office" } as const;
const member = (userId: string) => ({ kind: "user", userId }) as const;

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  removeStateDir(dirname(managedOfficeEnvPath()));
  removeStateDir(dirname(managedUserEnvPath("any")));
  removeStateDir(join(STATE_ROOT, "secrets"));
  removeStateDir(join(STATE_ROOT, "mcp-servers"));
  removeStateDir(join(STATE_ROOT, "opencode", "profile-keys.json"));
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
  // The incident: the office env file went away, and every OpenCode agent
  // moved to a new profile where its conversation was not.
  it("never moves when an env, secrets or MCP servers file appears or goes, for a member or unowned agents", () => {
    const sources = createMcpServerSources();
    const before = [
      environmentSourceKeyForUserId("u1"),
      environmentSourceKeyForUserId(null),
    ];
    const same = () =>
      expect([
        environmentSourceKeyForUserId("u1"),
        environmentSourceKeyForUserId(null),
      ]).toEqual(before);
    writeManagedOfficeEnv({ SHARED: "1" });
    same();
    writeManagedUserEnv("u1", { A: "1" });
    same();
    sources.secrets.create(member("u1"), {
      name: "TOKEN",
      value: "fake-key-test-value",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    });
    addServer(member("u1"), "docs");
    sources.secrets.create(office, {
      name: "OFFICE_TOKEN",
      value: "fake-key-test-value",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    });
    addServer(office, "shared");
    same();
    removeStateDir(managedOfficeEnvPath());
    removeStateDir(managedUserEnvPath("u1"));
    removeStateDir(join(STATE_ROOT, "secrets"));
    removeStateDir(join(STATE_ROOT, "mcp-servers"));
    same();
  });

  // The upgrade: the member stays on the profile the old rule gave them, also
  // after the file set that rule hashed changes.
  it("keeps a member on the legacy profile the migration adopted when their files change", () => {
    writeManagedOfficeEnv({ SHARED: "1" });
    writeManagedUserEnv("u1", { A: "1" });
    const legacy = legacyEnvironmentSourceKeyForUserId("u1");
    migrateProfileKeysOnce({
      owners: [
        {
          userId: "u1",
          agents: [
            { agentId: "a1", agentType: "opencode", lastSessionId: "s1" },
          ],
        },
      ],
      legacyKey: legacyEnvironmentSourceKeyForUserId,
      profileExists: (key) => key === legacy,
    });
    expect(environmentSourceKeyForUserId("u1")).toBe(legacy);
    removeStateDir(managedOfficeEnvPath());
    removeStateDir(managedUserEnvPath("u1"));
    expect(legacyEnvironmentSourceKeyForUserId("u1")).not.toBe(legacy);
    expect(environmentSourceKeyForUserId("u1")).toBe(legacy);
  });

  for (const withOfficeEnv of [false, true])
    it(`gives two members with personal MCP servers two profiles and their own servers (office env file: ${withOfficeEnv})`, () => {
      if (withOfficeEnv) writeManagedOfficeEnv({ SHARED: "1" });
      // Neither has a file of their own yet, and they still never share a
      // profile.
      expect(environmentSourceKeyForUserId("u1")).not.toBe(
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
          servers: supervisor.mcpServers.map((server) => server.name).sort(),
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
