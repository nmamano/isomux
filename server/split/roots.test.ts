// The identity rule (internal-docs/os-user-split-design.md, section 3.1.2): a
// migrated office keeps the OpenCode profile, the app unit names and the
// codex-home of the single-user office it came from. Each side runs in its
// own process, because the roots are read once at import.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveRoots } from "./roots.ts";

const SERVER = join(import.meta.dir, "..");
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const PROBE = `
const { environmentSourceKeyForUserId } = await import("${SERVER}/env-loader.ts");
const { openCodeProfilePaths } = await import("${SERVER}/backends/opencode/profile-paths.ts");
const { unitPrefixFor } = await import("${SERVER}/app-supervisor.ts");
const roots = await import("${SERVER}/split/roots.ts");
const codex = await import("${SERVER}/backends/codex/native-bin.ts");
const officeKey = environmentSourceKeyForUserId(null);
const userKey = environmentSourceKeyForUserId("u1");
console.log(JSON.stringify({
  split: roots.SPLIT_CONFIG !== null,
  officeKey,
  userKey,
  profile: openCodeProfilePaths(userKey).profileDir,
  unitPrefix: unitPrefixFor(roots.AGENT_ROOT, roots.AGENT_ROOT_IS_DEFAULT),
  codexHome: codex.ISOMUX_CODEX_HOME,
  wrapper: codex.codexWrapperCommandForShell(),
}));
`;

interface Identities {
  split: boolean;
  officeKey: string;
  userKey: string;
  profile: string;
  unitPrefix: string;
  codexHome: string;
  wrapper: string;
}

function probe(env: Record<string, string>): Identities {
  const result = Bun.spawnSync([process.execPath, "-e", PROBE], {
    env: { PATH: process.env.PATH!, ...env },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString()) as Identities;
}

// Managed office and personal variables, as the migration leaves them.
function stateWithEnvFiles(stateRoot: string): void {
  mkdirSync(join(stateRoot, "office-env"), { recursive: true });
  mkdirSync(join(stateRoot, "user-env"), { recursive: true });
  writeFileSync(join(stateRoot, "office-env", "office.env"), "A=1\n");
  writeFileSync(join(stateRoot, "user-env", "u1.env"), "B=2\n");
}

function splitOffice(
  serverHome: string,
  agentRoot: string,
  wasDefault: boolean,
) {
  const stateRoot = join(serverHome, ".isomux");
  stateWithEnvFiles(stateRoot);
  writeFileSync(
    join(stateRoot, "split.json"),
    JSON.stringify({
      agentUser: "agent",
      agentUid: 1000,
      agentRoot,
      agentRootWasDefault: wasDefault,
      shareRoot: join(serverHome, "share"),
    }),
  );
  return probe({
    HOME: serverHome,
    ISOMUX_HOME: stateRoot,
    ISOMUX_AGENT_RUNNER: "/run/isomux-agent-runner/runner.sock",
    ISOMUX_SPLIT_RIG: "1",
  });
}

describe("split roots", () => {
  it("keep every identity of an office on the default root", () => {
    dir = mkdtempSync(join(tmpdir(), "split-roots-"));
    const agentHome = join(dir, "agent-home");
    stateWithEnvFiles(join(agentHome, ".isomux"));
    const before = probe({ HOME: agentHome });
    const after = splitOffice(
      join(dir, "server-home"),
      join(agentHome, ".isomux"),
      true,
    );
    expect(before.split).toBe(false);
    expect(after.split).toBe(true);
    expect(before.userKey).not.toBe("default");
    expect(before.unitPrefix).toBe("isomux-app-");
    expect(before.wrapper).toBe("~/.isomux/bin/codex");
    expect({ ...after, split: false }).toEqual(before);
  });

  it("keep every identity of an office on a custom root", () => {
    dir = mkdtempSync(join(tmpdir(), "split-roots-"));
    const custom = join(dir, "custom-root");
    stateWithEnvFiles(custom);
    const before = probe({
      HOME: join(dir, "agent-home"),
      ISOMUX_HOME: custom,
    });
    const after = splitOffice(join(dir, "server-home"), custom, false);
    expect(before.unitPrefix).not.toBe("isomux-app-");
    expect(before.codexHome).toBe(join(custom, "codex-home"));
    expect({ ...after, split: false }).toEqual(before);
  });

  it("stay on the state root without the split gate or with a bad split.json", () => {
    const env = {
      ISOMUX_AGENT_RUNNER: "/run/x.sock",
      ISOMUX_SPLIT_RIG: "1",
    };
    const single = {
      split: null,
      agentRoot: "/state",
      agentRootIsDefault: true,
      shareRoot: "/state",
    };
    expect(resolveRoots({}, "/state", true)).toEqual(single);
    expect(
      resolveRoots({ ISOMUX_AGENT_RUNNER: "/run/x.sock" }, "/state", true),
    ).toEqual(single);
    dir = mkdtempSync(join(tmpdir(), "split-roots-"));
    writeFileSync(
      join(dir, "split.json"),
      JSON.stringify({ agentUser: "a", agentRoot: "relative" }),
    );
    expect(resolveRoots(env, dir, false)).toEqual({
      ...single,
      agentRoot: dir,
      agentRootIsDefault: false,
      shareRoot: dir,
    });
  });
});
