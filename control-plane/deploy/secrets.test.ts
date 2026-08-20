// The wrapper's failure paths, driven against a flyctl that misbehaves.
//
// The guarantee under test is NOT "the scanner catches leaks". It is that
// nothing the child wrote can reach a caller at all, whatever the child wrote
// and whether or not the scanner recognised it. So every case below plants a
// leak and then searches the WHOLE returned value for it - including the shapes
// an exact-value scan cannot see, which is exactly why the wrapper does not
// rely on that scan for safety.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CANARY_NAME,
  CANARY_VALUE,
  BOOT_REQUIRED_NAMES,
  SECRET_NAMES,
  pushCanary,
  pushSecrets,
  namesPresent,
  unsetCanary,
  validatePairs,
} from "./secrets.ts";
import { CONTABO_SECRET_NAMES } from "./fly-cli.ts";
import { CERTIFICATE_SECRET_NAMES } from "./secret-names.ts";
import type { Spawn, SpawnResult } from "./fly-cli.ts";

const DSN =
  "postgresql://role:hunter2@ep-secret-123.eu-central-1.aws.neon.tech/db";
const PAIRS = [{ name: "CONTROL_PLANE_DB", value: DSN }];

/** A flyctl that answers however a test needs it to, remembering its input. */
function fakeFly(answer: Partial<SpawnResult>): {
  spawn: Spawn;
  calls: { argv: string[]; env: Record<string, string>; stdin: string }[];
} {
  const calls: {
    argv: string[];
    env: Record<string, string>;
    stdin: string;
  }[] = [];
  const spawn: Spawn = async (argv, env, stdin) => {
    calls.push({ argv, env, stdin });
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { spawn, calls };
}

/** Everything a caller could print, as one string. */
function everythingReturned(value: unknown): string {
  return JSON.stringify(value);
}

describe("validation, before any child exists", () => {
  test("a value carrying a line break is refused", async () => {
    const fly = fakeFly({});
    const outcome = await pushSecrets({
      pairs: [{ name: "CONTROL_PLANE_DB", value: `${DSN}\nEXTRA=surprise` }],
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.spawned).toBe(false);
    expect(fly.calls).toHaveLength(0);
    expect(outcome.problems).toEqual([
      "value carries a line break: CONTROL_PLANE_DB",
    ]);
    // The refusal names the FIELD, never the value that caused it.
    expect(everythingReturned(outcome)).not.toContain("hunter2");
  });

  test("a name outside the allowlist is refused", () => {
    expect(
      validatePairs([{ name: "SOMETHING_ELSE", value: "x" }], SECRET_NAMES),
    ).toEqual(["not an allowed secret name: SOMETHING_ELSE"]);
  });

  test("an empty value, a NUL and a repeat are each refused", () => {
    expect(
      validatePairs([{ name: "CONTROL_PLANE_DB", value: "" }], SECRET_NAMES),
    ).toContain("empty value: CONTROL_PLANE_DB");
    expect(
      validatePairs(
        [{ name: "CONTROL_PLANE_DB", value: "a\0b" }],
        SECRET_NAMES,
      ),
    ).toContain("value carries a NUL: CONTROL_PLANE_DB");
    expect(
      validatePairs(
        [
          { name: "CONTROL_PLANE_DB", value: "a" },
          { name: "CONTROL_PLANE_DB", value: "b" },
        ],
        SECRET_NAMES,
      ),
    ).toContain("named twice: CONTROL_PLANE_DB");
  });
});

describe("the credential's route to the child", () => {
  test("the token goes in the environment and the value on stdin", async () => {
    const fly = fakeFly({});
    await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "fly-token-value",
      spawn: fly.spawn,
    });
    const call = fly.calls[0];
    // ARGV IS WHAT THE PROCESS TABLE SHOWS. Neither credential is in it.
    expect(call.argv.join(" ")).not.toContain("fly-token-value");
    expect(call.argv.join(" ")).not.toContain("hunter2");
    expect(call.argv).toEqual([
      call.argv[0],
      "secrets",
      "import",
      "-a",
      "isomux-provisioner",
      "--stage",
    ]);
    expect(call.env).toEqual({ FLY_API_TOKEN: "fly-token-value" });
    expect(call.stdin).toBe(`CONTROL_PLANE_DB=${DSN}\n`);
  });

  test("every call names the app this slice may touch", async () => {
    const fly = fakeFly({ stdout: "[]" });
    await namesPresent({
      required: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(fly.calls[0].argv).toContain("-a");
    expect(fly.calls[0].argv).toContain("isomux-provisioner");
  });
});

describe("a flyctl that repeats what it was given", () => {
  test("a full echo on stdout is caught, and still never returned", async () => {
    const fly = fakeFly({ stdout: `set CONTROL_PLANE_DB=${DSN}\n` });
    const outcome = await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.valueInChildOutput).toBe(true);
    expect(everythingReturned(outcome)).not.toContain("hunter2");
    expect(everythingReturned(outcome)).not.toContain("ep-secret-123");
  });

  test("a full echo on STDERR is caught too", async () => {
    const fly = fakeFly({ code: 1, stderr: `failed parsing ${DSN}\n` });
    const outcome = await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.valueInChildOutput).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(everythingReturned(outcome)).not.toContain("hunter2");
  });

  test("A FRAGMENT IS NOT CAUGHT - and is not returned either", async () => {
    // The password alone, which an exact-value scan cannot see. This is the
    // case that decides the design: the wrapper is safe here because it never
    // hands the child's bytes back, not because it recognised the leak.
    const fly = fakeFly({
      stderr: "password authentication failed for hunter2",
    });
    const outcome = await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.valueInChildOutput).toBe(false);
    expect(everythingReturned(outcome)).not.toContain("hunter2");
  });

  test("the token leaking into the child's output is not returned either", async () => {
    const fly = fakeFly({ stderr: "authenticating with fly-token-value" });
    const outcome = await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "fly-token-value",
      spawn: fly.spawn,
    });
    expect(everythingReturned(outcome)).not.toContain("fly-token-value");
  });

  test("a quiet flyctl is the positive control", async () => {
    const fly = fakeFly({
      stdout: "Secrets are staged for the first deployment\n",
    });
    const outcome = await pushSecrets({
      pairs: PAIRS,
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.valueInChildOutput).toBe(false);
    expect(outcome.exitCode).toBe(0);
    // The child's own words do not come back even when they are harmless.
    expect(everythingReturned(outcome)).not.toContain("staged");
  });
});

describe("the canary", () => {
  test("is public, so a leak of it is an observation", () => {
    expect(CANARY_VALUE).toBe("isomux-d2-public-canary");
    expect(CANARY_NAME).toBe("PROBE_CANARY");
    expect(SECRET_NAMES).not.toContain(CANARY_NAME as never);
  });

  test("takes no name and no value, so it can set nothing else", async () => {
    const fly = fakeFly({});
    await pushCanary({ flyToken: "t", spawn: fly.spawn });
    // The name and the value are constants of the function, so what reaches
    // flyctl is fixed no matter who calls it - which matters because this runs
    // before anything real has been set.
    expect(fly.calls[0].stdin).toBe(`${CANARY_NAME}=${CANARY_VALUE}\n`);
    expect(fly.calls[0].argv).toContain("isomux-provisioner");
  });

  test("an echoing flyctl is what it is there to find", async () => {
    const fly = fakeFly({ stdout: `PROBE_CANARY=${CANARY_VALUE}` });
    const outcome = await pushCanary({ flyToken: "t", spawn: fly.spawn });
    expect(outcome.valueInChildOutput).toBe(true);
  });

  test("the canary path does not widen the production allowlist", async () => {
    const fly = fakeFly({});
    const outcome = await pushSecrets({
      pairs: [{ name: CANARY_NAME, value: CANARY_VALUE }],
      allowed: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(outcome.spawned).toBe(false);
    expect(outcome.problems).toEqual([
      `not an allowed secret name: ${CANARY_NAME}`,
    ]);
  });

  test("unsetting names the probe and nothing else", async () => {
    const fly = fakeFly({});
    const outcome = await unsetCanary({ flyToken: "t", spawn: fly.spawn });
    expect(outcome).toEqual({ exitCode: 0 });
    expect(fly.calls[0].argv).toEqual([
      fly.calls[0].argv[0],
      "secrets",
      "unset",
      "PROBE_CANARY",
      "-a",
      "isomux-provisioner",
      "--stage",
    ]);
    for (const name of SECRET_NAMES) {
      expect(fly.calls[0].argv).not.toContain(name);
    }
  });

  test("an unset that failed returns a code and no child words", async () => {
    const fly = fakeFly({ code: 1, stderr: "could not remove PROBE_CANARY" });
    const outcome = await unsetCanary({ flyToken: "t", spawn: fly.spawn });
    expect(outcome).toEqual({ exitCode: 1 });
    expect(everythingReturned(outcome)).not.toContain("could not remove");
  });
});

describe("what the allowlist may carry (D4, 2026-08-12)", () => {
  test("THREE names, and no provider credential among them", () => {
    // The provider four were briefly here, and that was the defect: this
    // program stages CONTROL_PLANE_DB from the operator's env file, which holds
    // the break-glass owner string, so any run of it carrying provider
    // credentials would also have moved the deployment's database credential.
    expect([...SECRET_NAMES]).toEqual([
      "CONTROL_PLANE_DB",
      "CONTROL_PLANE_DB_BRANCH",
      "CONTROL_PLANE_MINT_TOKEN",
    ]);
    for (const name of CONTABO_SECRET_NAMES) {
      expect({
        name,
        here: (SECRET_NAMES as readonly string[]).includes(name),
      }).toEqual({ name, here: false });
    }
  });

  test("a provider name handed to THIS importer is refused before a child exists", () => {
    for (const name of CONTABO_SECRET_NAMES) {
      expect(validatePairs([{ name, value: "x" }], SECRET_NAMES)).toEqual([
        `not an allowed secret name: ${name}`,
      ]);
    }
  });

  test("the three it IS for are still validated like any other value", () => {
    expect(
      validatePairs(
        [{ name: "CONTROL_PLANE_DB", value: "fine" }],
        SECRET_NAMES,
      ),
    ).toEqual([]);
    expect(
      validatePairs(
        [{ name: "CONTROL_PLANE_DB", value: "one\nTWO=surprise" }],
        SECRET_NAMES,
      ),
    ).toEqual(["value carries a line break: CONTROL_PLANE_DB"]);
  });
});

describe("the name check", () => {
  test("the boot verifier requires families owned by this importer", () => {
    expect([...BOOT_REQUIRED_NAMES]).toEqual([
      ...SECRET_NAMES,
      ...CONTABO_SECRET_NAMES,
      ...CERTIFICATE_SECRET_NAMES,
    ]);
  });

  test("the command's verify arm uses the boot-required set", () => {
    const source = readFileSync(
      new URL("./secrets.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('if (mode === "--verify")');
    const end = source.indexOf("// The credential file is checked HERE");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const verifyArm = source.slice(start, end);
    expect(verifyArm).toContain("required: BOOT_REQUIRED_NAMES");
    expect(verifyArm).toContain("for (const name of BOOT_REQUIRED_NAMES)");
    expect(verifyArm).not.toContain("required: SECRET_NAMES");
  });

  test("reports presence without ever printing a digest", async () => {
    const rows = SECRET_NAMES.map((n) => ({
      Name: n,
      Digest: "d41d8cd98f00b204",
    }));
    const fly = fakeFly({ stdout: JSON.stringify(rows) });
    const answer = await namesPresent({
      required: SECRET_NAMES,
      flyToken: "t",
      spawn: fly.spawn,
    });
    expect(answer).toEqual({ present: true, readable: true });
    expect(everythingReturned(answer)).not.toContain("d41d8cd98f00b204");
  });

  test("a missing name is false, not an error", async () => {
    const fly = fakeFly({
      stdout: JSON.stringify([{ Name: "CONTROL_PLANE_DB" }]),
    });
    expect(
      await namesPresent({
        required: SECRET_NAMES,
        flyToken: "t",
        spawn: fly.spawn,
      }),
    ).toEqual({ present: false, readable: true });
  });

  test("each missing boot requirement makes the full check false", async () => {
    for (const missing of BOOT_REQUIRED_NAMES) {
      const fly = fakeFly({
        stdout: JSON.stringify(
          BOOT_REQUIRED_NAMES.filter((name) => name !== missing).map(
            (Name) => ({ Name }),
          ),
        ),
      });
      expect(
        await namesPresent({
          required: BOOT_REQUIRED_NAMES,
          flyToken: "t",
          spawn: fly.spawn,
        }),
      ).toEqual({ present: false, readable: true });
    }
  });

  test("an unreadable listing refuses rather than guessing", async () => {
    const broken = fakeFly({ stdout: "not json" });
    expect(
      await namesPresent({
        required: SECRET_NAMES,
        flyToken: "t",
        spawn: broken.spawn,
      }),
    ).toEqual({ present: false, readable: false });
    const failed = fakeFly({ code: 1, stderr: "unauthorized" });
    expect(
      await namesPresent({
        required: SECRET_NAMES,
        flyToken: "t",
        spawn: failed.spawn,
      }),
    ).toEqual({ present: false, readable: false });
  });
});
