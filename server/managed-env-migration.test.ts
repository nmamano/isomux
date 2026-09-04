import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import { migrateManagedEnvAtBoot } from "./managed-env-migration.ts";
import { readEnvFile } from "./persistence.ts";
import {
  managedOfficeEnvExists,
  managedOfficeEnvPath,
  managedUserEnvExists,
  managedUserEnvPath,
  readManagedOfficeEnv,
  readManagedUserEnv,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";
import type { UserRecord } from "../shared/types.ts";

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

function user(path: string | null): UserRecord {
  return {
    id: USER_ID,
    name: "Migration User",
    role: "member",
    envFile: path,
    createdAt: 1,
    notifRooms: [],
    allowedRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    avatarColor: "#000000",
    avatarVariant: "classic",
    language: null,
  };
}

describe("managed env boot migration", () => {
  it("imports office and user values once through the real parser and reader", () => {
    const fixtures = join(STATE_ROOT, "migration-fixtures");
    mkdirSync(fixtures, { recursive: true });
    const officePath = join(fixtures, "office.env");
    const userPath = join(fixtures, "user.env");
    writeFileSync(officePath, "GH_TOKEN=office\nTRAILING='office value '\n");
    writeFileSync(
      userPath,
      "GH_TOKEN=\"user's token\"\nTRAILING='user value '\n",
    );
    let officeLegacy: string | null = officePath;
    const record = user(userPath);
    let officeWrites = 0;
    let userWrites = 0;
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
      users: [record],
      userSubject: () => ({
        label: `user "${record.name}"`,
        get path() {
          return record.envFile;
        },
        legacyExists: existsSync,
        managedExists: () => managedUserEnvExists(record.id),
        readManaged: () => readManagedUserEnv(record.id),
        readLegacy: (path: string) => {
          reads++;
          return readEnvFile(path);
        },
        writeManaged: (values: Record<string, string>) => {
          userWrites++;
          writeManagedUserEnv(record.id, values);
        },
        clearLegacyPath: () => {
          record.envFile = null;
        },
      }),
      log: () => {},
    };

    migrateManagedEnvAtBoot(deps);
    expect(readManagedOfficeEnv()).toEqual({
      GH_TOKEN: "office",
      TRAILING: "office value ",
    });
    expect(readManagedUserEnv(USER_ID)).toEqual({
      GH_TOKEN: "user's token",
      TRAILING: "user value ",
    });
    expect({ officeWrites, userWrites, reads }).toEqual({
      officeWrites: 1,
      userWrites: 1,
      reads: 2,
    });

    migrateManagedEnvAtBoot(deps);
    expect({ officeWrites, userWrites, reads }).toEqual({
      officeWrites: 1,
      userWrites: 1,
      reads: 2,
    });
  });

  it("continues after every subject failure without logging values", () => {
    const fixtures = join(STATE_ROOT, "migration-fixtures");
    mkdirSync(fixtures, { recursive: true });
    const officePath = join(fixtures, "office.env");
    const badKeyPath = join(fixtures, "bad-key.env");
    writeFileSync(officePath, 'KEY="secret\\nvalue"\n');
    writeFileSync(badKeyPath, "MY-VAR=secret-value\n");
    let officeLegacy: string | null = officePath;
    const record = user(badKeyPath);
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
        users: [record],
        userSubject: () => ({
          label: `user "${record.name}"`,
          get path() {
            return record.envFile;
          },
          legacyExists: existsSync,
          managedExists: () => managedUserEnvExists(record.id),
          readManaged: () => readManagedUserEnv(record.id),
          readLegacy: readEnvFile,
          writeManaged: (values) => writeManagedUserEnv(record.id, values),
          clearLegacyPath: () => {
            record.envFile = null;
          },
        }),
        log: (message) => logs.push(message),
      }),
    ).not.toThrow();

    expect(officeLegacy).toBe(officePath);
    expect(record.envFile).toBe(badKeyPath);
    expect(logs).toEqual([
      "[managed env migration] could not import office variables; retrying on next boot",
      '[managed env migration] could not import user "Migration User"; retrying on next boot',
    ]);
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("clears a missing legacy path instead of retrying forever", () => {
    const missing = join(STATE_ROOT, "migration-fixtures", "missing.env");
    const record = user(missing);
    const logs: string[] = [];

    migrateManagedEnvAtBoot({
      office: {
        label: "office variables",
        path: null,
        legacyExists: existsSync,
        managedExists: managedOfficeEnvExists,
        readManaged: readManagedOfficeEnv,
        readLegacy: readEnvFile,
        writeManaged: writeManagedOfficeEnv,
        clearLegacyPath: () => {},
      },
      users: [record],
      userSubject: () => ({
        label: `user "${record.name}"`,
        get path() {
          return record.envFile;
        },
        legacyExists: existsSync,
        managedExists: () => managedUserEnvExists(USER_ID),
        readManaged: () => readManagedUserEnv(USER_ID),
        readLegacy: readEnvFile,
        writeManaged: (values) => writeManagedUserEnv(USER_ID, values),
        clearLegacyPath: () => {
          record.envFile = null;
        },
      }),
      log: (message) => logs.push(message),
    });

    expect(record.envFile).toBeNull();
    expect(logs).toEqual([
      '[managed env migration] cleared missing env file for user "Migration User"',
    ]);
  });

  it("does not overwrite different managed values and finishes an identical crash retry", () => {
    const fixtures = join(STATE_ROOT, "migration-fixtures");
    mkdirSync(fixtures, { recursive: true });
    const legacy = join(fixtures, "user.env");
    writeFileSync(legacy, "GH_TOKEN=legacy\n");
    const record = user(legacy);
    writeManagedUserEnv(USER_ID, { GH_TOKEN: "managed" });
    const logs: string[] = [];
    const run = () =>
      migrateManagedEnvAtBoot({
        office: {
          label: "office variables",
          path: null,
          legacyExists: existsSync,
          managedExists: managedOfficeEnvExists,
          readManaged: readManagedOfficeEnv,
          readLegacy: readEnvFile,
          writeManaged: writeManagedOfficeEnv,
          clearLegacyPath: () => {},
        },
        users: [record],
        userSubject: () => ({
          label: `user "${record.name}"`,
          get path() {
            return record.envFile;
          },
          legacyExists: existsSync,
          managedExists: () => managedUserEnvExists(USER_ID),
          readManaged: () => readManagedUserEnv(USER_ID),
          readLegacy: readEnvFile,
          writeManaged: (values) => writeManagedUserEnv(USER_ID, values),
          clearLegacyPath: () => {
            record.envFile = null;
          },
        }),
        log: (message) => logs.push(message),
      });
    run();
    expect(readManagedUserEnv(USER_ID)).toEqual({ GH_TOKEN: "managed" });
    expect(record.envFile).toBe(legacy);

    writeManagedUserEnv(USER_ID, { GH_TOKEN: "legacy" });
    run();
    expect(record.envFile).toBeNull();
  });
});
