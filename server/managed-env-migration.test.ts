import { afterEach, describe, expect, it } from "bun:test";
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

afterEach(() => {
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath(USER_ID)), {
    recursive: true,
    force: true,
  });
  rmSync(join(STATE_ROOT, "migration-fixtures"), {
    recursive: true,
    force: true,
  });
});

describe("managed env boot migration", () => {
  it("imports office values once through the real parser and reader", () => {
    const fixtures = join(STATE_ROOT, "migration-fixtures");
    mkdirSync(fixtures, { recursive: true });
    const officePath = join(fixtures, "office.env");
    writeFileSync(officePath, "GH_TOKEN=office\nTRAILING='office value '\n");
    let officeLegacy: string | null = officePath;
    let officeWrites = 0;
    let reads = 0;
    const deps = {
      office: {
        label: "office variables",
        get path() {
          return officeLegacy;
        },
        legacyExists: existsSync,
        managedExists: managedOfficeEnvExists,
        readManaged: readManagedOfficeEnv,
        readLegacy: (path: string) => {
          reads++;
          return readEnvFile(path);
        },
        writeManaged: (values: Record<string, string>) => {
          officeWrites++;
          writeManagedOfficeEnv(values);
        },
        clearLegacyPath: () => {
          officeLegacy = null;
        },
      },
      log: () => {},
    };

    migrateManagedEnvAtBoot(deps);
    expect(readManagedOfficeEnv()).toEqual({
      GH_TOKEN: "office",
      TRAILING: "office value ",
    });
    expect({ officeWrites, reads }).toEqual({
      officeWrites: 1,
      reads: 1,
    });

    migrateManagedEnvAtBoot(deps);
    expect({ officeWrites, reads }).toEqual({
      officeWrites: 1,
      reads: 1,
    });
  });

  it("continues after an office import failure without logging values", () => {
    const fixtures = join(STATE_ROOT, "migration-fixtures");
    mkdirSync(fixtures, { recursive: true });
    const officePath = join(fixtures, "office.env");
    writeFileSync(officePath, 'KEY="secret\\nvalue"\n');
    let officeLegacy: string | null = officePath;
    const logs: string[] = [];

    expect(() =>
      migrateManagedEnvAtBoot({
        office: {
          label: "office variables",
          get path() {
            return officeLegacy;
          },
          legacyExists: existsSync,
          managedExists: managedOfficeEnvExists,
          readManaged: readManagedOfficeEnv,
          readLegacy: readEnvFile,
          writeManaged: writeManagedOfficeEnv,
          clearLegacyPath: () => {
            officeLegacy = null;
          },
        },
        log: (message) => logs.push(message),
      }),
    ).not.toThrow();

    expect(officeLegacy).toBe(officePath);
    expect(logs).toEqual([
      "[managed env migration] could not import office variables; retrying on next boot",
    ]);
    expect(logs.join("\n")).not.toContain("secret");
  });
});
