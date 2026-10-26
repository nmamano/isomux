import { afterEach, describe, expect, it } from "bun:test";
import { dirname } from "path";
import {
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
  buildEnvForUserId,
  envSourceForUserId,
  setOfficeEnvFileProvider,
  setSecretEnvironmentProvider,
} from "./env-loader.ts";
import {
  activatePersonalProvider,
  deactivatePersonalProvider,
  personalProviderHome,
} from "./provider-homes.ts";
import { claimUser } from "./users.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";
import type { ProviderAccountProvider } from "../shared/types.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  // The managed env files are process-wide state; a later test file must not
  // inherit the values these tests wrote.
  removeStateDir(dirname(managedOfficeEnvPath()));
  removeStateDir(dirname(managedUserEnvPath("any")));
});

// Sets process env names for the run, then puts back what was there.
function withProcessEnv(
  values: Record<string, string | undefined>,
  run: () => void,
): void {
  const prior = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const assign = (next: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    assign(values);
    run();
  } finally {
    assign(prior);
  }
}

// Activates personal providers through the real state file for the run.
function withPersonalProviders(
  userId: string,
  providers: ProviderAccountProvider[],
  run: () => void,
): void {
  try {
    for (const provider of providers)
      activatePersonalProvider(userId, provider);
    run();
  } finally {
    for (const provider of providers)
      deactivatePersonalProvider(userId, provider);
  }
}

describe("environment source identity", () => {
  it("keys on the managed paths; contents change only the revision, process state neither", () => {
    const user = claimUser("Env Identity User");
    const ids = [null, user.id];
    const keys = () => ids.map((id) => environmentSourceKeyForUserId(id));
    const revisions = () =>
      ids.map((id) => environmentSourceRevisionForUserId(id));
    withProcessEnv({ INVOCATION_ID: "first-start" }, () => {
      writeManagedOfficeEnv({ PROVIDER_KEY: "first" });
      writeManagedUserEnv(user.id, { MEMBER_KEY: "first" });
      const firstKeys = keys();
      const firstRevisions = revisions();
      process.env.INVOCATION_ID = "second-start";
      expect(keys()).toEqual(firstKeys);
      expect(revisions()).toEqual(firstRevisions);

      writeManagedOfficeEnv({ PROVIDER_KEY: "rotated", UNRELATED: "value" });
      expect(keys()).toEqual(firstKeys);
      const officeRotated = revisions();
      expect(officeRotated[0]).not.toBe(firstRevisions[0]);
      expect(officeRotated[1]).not.toBe(firstRevisions[1]);

      writeManagedUserEnv(user.id, { MEMBER_KEY: "rotated" });
      expect(keys()).toEqual(firstKeys);
      expect(revisions()[0]).toBe(officeRotated[0]);
      expect(revisions()[1]).not.toBe(officeRotated[1]);
    });
  });
});

describe("activated personal provider environment", () => {
  it("sets each activated provider's home alone, with no env file", () => {
    const user = "01a19e7b";
    const cases: [ProviderAccountProvider, string, string][] = [
      ["claude", "CLAUDE_CONFIG_DIR", "CODEX_HOME"],
      ["codex", "CODEX_HOME", "CLAUDE_CONFIG_DIR"],
    ];
    withProcessEnv(
      { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined },
      () => {
        for (const [provider, home, other] of cases)
          withPersonalProviders(user, [provider], () => {
            const env = buildEnvForUserId(user);
            expect(env?.[home]).toBe(personalProviderHome(user, provider));
            expect(env?.[other]).toBeUndefined();
          });
      },
    );
  });
});

describe("managed user environment", () => {
  it("layers process, office and member values, and keeps a member's own provider home", () => {
    const user = claimUser("Managed Precedence User");
    withProcessEnv({ GH_TOKEN: "process" }, () =>
      withPersonalProviders(user.id, ["claude", "codex"], () => {
        writeManagedOfficeEnv({ GH_TOKEN: "office", OFFICE_ONLY: "office" });
        expect(buildEnvForUserId(null)?.GH_TOKEN).toBe("office");

        writeManagedUserEnv(user.id, {
          GH_TOKEN: "user",
          CLAUDE_CONFIG_DIR: "/explicit/claude",
        });
        expect(buildEnvForUserId(user.id)).toMatchObject({
          GH_TOKEN: "user",
          OFFICE_ONLY: "office",
          CLAUDE_CONFIG_DIR: "/explicit/claude",
          CODEX_HOME: personalProviderHome(user.id, "codex"),
        });
      }),
    );
  });
});

// Where the Codex card says a member's agents get OPENAI_API_KEY: the last
// layer of buildEnvForUserId's merge that defines it (task a704657a).
describe("envSourceForUserId", () => {
  const KEY = "OPENAI_API_KEY";
  const secrets = (
    office: Record<string, string>,
    member: Record<string, Record<string, string>>,
  ) =>
    setSecretEnvironmentProvider((userId) => ({
      office,
      member: (userId && member[userId]) || {},
      fixed: {},
      gitCredentials: [],
      revision: "test",
    }));
  // The agents' value, as the spawn sees it: no merge in scope means the
  // agent host's own env.
  const agentValue = (userId: string | null) =>
    (buildEnvForUserId(userId) ?? process.env)[KEY];

  const withProcessKey = (value: string | undefined, run: () => void) => {
    const prior = process.env[KEY];
    const restoreSecrets = setSecretEnvironmentProvider(() => null);
    try {
      if (value === undefined) delete process.env[KEY];
      else process.env[KEY] = value;
      run();
    } finally {
      setSecretEnvironmentProvider(restoreSecrets);
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  };

  it("names the last layer that defines the key, per member", () => {
    const user = claimUser("Key Source User");
    const other = claimUser("Key Source Other");
    withProcessKey(undefined, () => {
      expect(envSourceForUserId(user.id, KEY)).toBeNull();

      process.env[KEY] = "from-process";
      expect(envSourceForUserId(user.id, KEY)).toBe("server");

      writeManagedOfficeEnv({ [KEY]: "office-variable" });
      expect(envSourceForUserId(user.id, KEY)).toBe("office_variable");

      secrets({ [KEY]: "office-secret" }, {});
      expect(envSourceForUserId(user.id, KEY)).toBe("office_secret");

      writeManagedUserEnv(user.id, { [KEY]: "member-variable" });
      expect(envSourceForUserId(user.id, KEY)).toBe("member_variable");

      secrets({ [KEY]: "office-secret" }, { [user.id]: { [KEY]: "member" } });
      expect(envSourceForUserId(user.id, KEY)).toBe("member_secret");

      // The member layers are the member's own: another member and an
      // unowned context still get the office secret.
      expect(envSourceForUserId(other.id, KEY)).toBe("office_secret");
      expect(envSourceForUserId(null, KEY)).toBe("office_secret");
      // Another name has its own source.
      expect(
        envSourceForUserId(user.id, "NOT_SET_ANYWHERE_A704657A"),
      ).toBeNull();
    });
  });

  it("says no key when a later layer empties it, as the agents get it", () => {
    const user = claimUser("Key Source Empty User");
    withProcessKey("from-process", () => {
      writeManagedOfficeEnv({ [KEY]: "office-variable" });
      writeManagedUserEnv(user.id, { [KEY]: "" });
      expect(agentValue(user.id)).toBe("");
      expect(envSourceForUserId(user.id, KEY)).toBeNull();
      expect(envSourceForUserId(null, KEY)).toBe("office_variable");

      // A secret over the empty variable sets it again.
      secrets({}, { [user.id]: { [KEY]: "member-secret" } });
      expect(agentValue(user.id)).toBe("member-secret");
      expect(envSourceForUserId(user.id, KEY)).toBe("member_secret");
    });
  });

  it("fails like the merge while an office env file waits for import", () => {
    setOfficeEnvFileProvider(() => "/tmp/pending-import.env");
    let mergeError: unknown;
    try {
      buildEnvForUserId(null);
    } catch (err) {
      mergeError = err;
    }
    expect(mergeError).toBeInstanceOf(Error);
    expect(() => envSourceForUserId(null, KEY)).toThrow(
      (mergeError as Error).message,
    );
  });
});
