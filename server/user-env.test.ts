import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, rmSync, statSync } from "fs";
import { dirname } from "path";

import { parseDotenv, readEnvFile } from "./persistence.ts";
import {
  ManagedEnvValidationError,
  managedOfficeEnvPath,
  managedUserEnvExists,
  managedUserEnvPath,
  serializeManagedUserEnv,
  writeManagedUserEnv,
  writeManagedOfficeEnv,
  readManagedOfficeEnv,
} from "./user-env.ts";

const USER_ID = "user-env-test";
// Only this user's entries: the user-env directory is a per-process
// singleton shared with every test file bun runs in the same process (GitHub
// CI ran other files first and their users' files were present). The check
// that matters is that no temp file from the atomic write is left behind
// next to the final one.
const ownEntries = () =>
  readdirSync(dirname(path)).filter((name) => name.startsWith(USER_ID));
const path = managedUserEnvPath(USER_ID);

afterEach(() => {
  rmSync(dirname(path), { recursive: true, force: true });
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
});

describe("managed user env storage", () => {
  it("round-trips awkward values through the production dotenv parser", () => {
    const values = {
      SPACE: " a b ",
      SINGLE_QUOTE: "a'b",
      DOUBLE_QUOTE: 'a"b',
      DOLLAR: "a$b",
      BACKSLASH: "a\\b",
      EQUALS: "a=b",
      HASH: "a # b",
      TAB: "a\tb",
      EMPTY: "",
      UNICODE: "café",
    };

    const encoded = serializeManagedUserEnv(values);
    expect(
      encoded
        .split("\n")
        .filter(Boolean)
        .every((line) => /='.*'$/.test(line)),
    ).toBe(true);
    expect(parseDotenv(encoded)).toEqual(values);

    writeManagedUserEnv(USER_ID, values);
    expect(readEnvFile(path)).toEqual(values);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ownEntries()).toEqual([`${USER_ID}.env`]);
  });

  it("atomically replaces a file and leaves an empty file for no keys", () => {
    writeManagedUserEnv(USER_ID, { FIRST: "one" });
    writeManagedUserEnv(USER_ID, {});

    expect(readEnvFile(path)).toEqual({});
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ownEntries()).toEqual([`${USER_ID}.env`]);
  });

  it("uses the shared atomic writer and permissions for office values", () => {
    writeManagedOfficeEnv({ GH_TOKEN: "office" });

    expect(readManagedOfficeEnv()).toEqual({ GH_TOKEN: "office" });
    expect(statSync(dirname(managedOfficeEnvPath())).mode & 0o777).toBe(0o700);
    expect(statSync(managedOfficeEnvPath()).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid keys, line breaks, and unsafe user ids before writing", () => {
    expect(() => writeManagedUserEnv(USER_ID, { "BAD-KEY": "secret" })).toThrow(
      ManagedEnvValidationError,
    );
    expect(() => writeManagedUserEnv(USER_ID, { GOOD: "line\nbreak" })).toThrow(
      ManagedEnvValidationError,
    );
    expect(() => managedUserEnvPath("../escape")).toThrow(
      ManagedEnvValidationError,
    );
    expect(managedUserEnvExists("../legacy-id")).toBe(false);
    expect(() =>
      writeManagedUserEnv(
        USER_ID,
        Object.fromEntries([["__proto__", "secret"]]),
      ),
    ).toThrow(ManagedEnvValidationError);
  });
});
