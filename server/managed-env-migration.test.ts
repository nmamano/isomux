import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import { migrateManagedEnvAtBoot } from "./managed-env-migration.ts";
import { readEnvFile } from "./persistence.ts";
import {
  managedOfficeEnvExists,
  managedOfficeEnvPath,
  managedUserEnvPath,
  readManagedOfficeEnv,
  writeManagedOfficeEnv,
} from "./user-env.ts";

const USER_ID = "migration-user";

// Before as well as after: a managed office env another test file left
// behind would read as already migrated.
function clearManagedEnv(): void {
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath(USER_ID)), {
    recursive: true,
    force: true,
  });
  rmSync(join(STATE_ROOT, "migration-fixtures"), {
    recursive: true,
    force: true,
  });
}

beforeEach(clearManagedEnv);
afterEach(clearManagedEnv);

// The office subject over the real parser and the real managed store, with
// counters on the reads and writes.
function officeSubject(legacyText: string) {
  const fixtures = join(STATE_ROOT, "migration-fixtures");
  mkdirSync(fixtures, { recursive: true });
  const officePath = join(fixtures, "office.env");
  writeFileSync(officePath, legacyText);
  const state = {
    legacy: officePath as string | null,
    writes: 0,
    reads: 0,
    logs: [] as string[],
  };
  const deps = {
    office: {
      label: "office variables",
      get path() {
        return state.legacy;
      },
      legacyExists: existsSync,
      managedExists: managedOfficeEnvExists,
      readManaged: readManagedOfficeEnv,
      readLegacy: (path: string) => {
        state.reads++;
        return readEnvFile(path);
      },
      writeManaged: (values: Record<string, string>) => {
        state.writes++;
        writeManagedOfficeEnv(values);
      },
      clearLegacyPath: () => {
        state.legacy = null;
      },
    },
    log: (message: string) => state.logs.push(message),
  };
  return { state, deps, officePath };
}

describe("managed env boot migration", () => {
  it("imports office values once through the real parser and reader", () => {
    const { state, deps } = officeSubject(
      "GH_TOKEN=office\nTRAILING='office value '\n",
    );

    migrateManagedEnvAtBoot(deps);
    expect(readManagedOfficeEnv()).toEqual({
      GH_TOKEN: "office",
      TRAILING: "office value ",
    });
    expect({ writes: state.writes, reads: state.reads }).toEqual({
      writes: 1,
      reads: 1,
    });

    migrateManagedEnvAtBoot(deps);
    expect({ writes: state.writes, reads: state.reads }).toEqual({
      writes: 1,
      reads: 1,
    });
  });

  // A boot that stopped after the managed write: the same values finish the
  // import by clearing the marker.
  it("clears the marker when the managed values already match", () => {
    writeManagedOfficeEnv({ A: "one", B: "two" });
    const { state, deps } = officeSubject("A=one\nB=two\n");

    migrateManagedEnvAtBoot(deps);
    expect(state.legacy).toBeNull();
    expect(state.writes).toBe(0);
    expect(state.logs).toEqual([]);
    expect(readManagedOfficeEnv()).toEqual({ A: "one", B: "two" });
  });

  // Values a member saved in the managed editor are never overwritten, and
  // the marker stays so an operator can resolve the collision.
  it("keeps the managed values and the marker when they differ, and logs no value", () => {
    writeManagedOfficeEnv({ A: "saved-in-editor" });
    const { state, deps, officePath } = officeSubject("A=from-legacy-file\n");

    migrateManagedEnvAtBoot(deps);
    expect(state.legacy).toBe(officePath);
    expect(state.writes).toBe(0);
    expect(readManagedOfficeEnv()).toEqual({ A: "saved-in-editor" });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toContain("office variables");
    for (const secret of ["saved-in-editor", "from-legacy-file", officePath])
      expect(state.logs[0]).not.toContain(secret);
  });
});
