import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import {
  activatePersonalProvider,
  ensurePersonalProviderHome,
  isPersonalProviderActive,
  personalProviderHome,
  removePersonalProviderHomes,
  sweepPersonalProviderHomes,
} from "./provider-homes.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

const stateFile = join(STATE_ROOT, "provider-account-state.json");
const homesDir = join(STATE_ROOT, "provider-homes");

const victimDir = join(STATE_ROOT, "provider-homes-victim");

afterEach(() => {
  removeStateDir(stateFile);
  removeStateDir(homesDir);
  removeStateDir(victimDir);
});

// A member's two homes, each with a sign-in and a conversation file.
function seedHomes(userId: string): string {
  for (const provider of ["claude", "codex"] as const) {
    const home = ensurePersonalProviderHome(userId, provider);
    writeFileSync(join(home, "signed-in"), "x");
    activatePersonalProvider(userId, provider);
  }
  return join(homesDir, userId);
}

describe("personal provider homes", () => {
  it("uses stable user ids and creates every directory at 0700", () => {
    const home = ensurePersonalProviderHome("01a19e7b", "claude");
    expect(home).toBe(personalProviderHome("01a19e7b", "claude"));
    for (const path of [homesDir, join(homesDir, "01a19e7b"), home]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
  });

  it("records activation independently of directory existence", () => {
    const home = personalProviderHome("01a19e7b", "codex");
    mkdirSync(home, { recursive: true });
    expect(isPersonalProviderActive("01a19e7b", "codex")).toBe(false);
    activatePersonalProvider("01a19e7b", "codex");
    expect(isPersonalProviderActive("01a19e7b", "codex")).toBe(true);
    expect(isPersonalProviderActive("renamed-display", "codex")).toBe(false);
  });
});

// A removed member's purge and the boot sweep (task 548d607b).
describe("removing personal provider homes", () => {
  it("removes the member's folder and state entry, and nobody else's", () => {
    const gone = seedHomes("01a19e7b");
    const kept = seedHomes("5b246ad1");

    removePersonalProviderHomes("01a19e7b");
    expect(existsSync(gone)).toBe(false);
    expect(isPersonalProviderActive("01a19e7b", "claude")).toBe(false);
    expect(isPersonalProviderActive("01a19e7b", "codex")).toBe(false);
    expect(existsSync(join(kept, "claude", "signed-in"))).toBe(true);
    expect(isPersonalProviderActive("5b246ad1", "codex")).toBe(true);

    // Again, with nothing left: not an error.
    removePersonalProviderHomes("01a19e7b");
  });

  it("refuses an id that is not one path segment, before any delete", () => {
    seedHomes("01a19e7b");
    mkdirSync(victimDir, { recursive: true });
    for (const id of ["", "..", "../provider-homes-victim", "a/b"]) {
      expect(() => removePersonalProviderHomes(id)).toThrow();
    }
    expect(existsSync(victimDir)).toBe(true);
    expect(existsSync(join(homesDir, "01a19e7b", "claude", "signed-in"))).toBe(
      true,
    );
  });

  it("the sweep removes the folders and state entries of ids not kept, and leaves entries that are not ids", () => {
    const live = seedHomes("01a19e7b");
    const removed = seedHomes("5b246ad1");
    const orphan = seedHomes("0dd1d00d");
    // A state entry with no folder.
    activatePersonalProvider("72c51bcf", "claude");
    const notAnId = join(homesDir, "not.an.id");
    mkdirSync(notAnId, { recursive: true });

    sweepPersonalProviderHomes(["01a19e7b", "5b246ad1"]);
    expect(existsSync(orphan)).toBe(false);
    expect(isPersonalProviderActive("0dd1d00d", "claude")).toBe(false);
    expect(isPersonalProviderActive("72c51bcf", "claude")).toBe(false);
    for (const kept of [live, removed])
      expect(existsSync(join(kept, "codex", "signed-in"))).toBe(true);
    expect(isPersonalProviderActive("01a19e7b", "claude")).toBe(true);
    expect(isPersonalProviderActive("5b246ad1", "codex")).toBe(true);
    expect(existsSync(notAnId)).toBe(true);
  });

  it("the sweep does nothing without a provider-homes folder, and never rewrites a state file it cannot read", () => {
    sweepPersonalProviderHomes([]);
    expect(existsSync(homesDir)).toBe(false);

    const orphan = seedHomes("0dd1d00d");
    writeFileSync(stateFile, "{ not json");
    sweepPersonalProviderHomes([]);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(stateFile, "utf8")).toBe("{ not json");
  });
});
