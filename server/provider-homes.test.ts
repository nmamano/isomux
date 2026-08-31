import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import {
  activatePersonalProvider,
  ensurePersonalProviderHome,
  isPersonalProviderActive,
  personalProviderHome,
} from "./provider-homes.ts";

const stateFile = join(STATE_ROOT, "provider-account-state.json");
const homesDir = join(STATE_ROOT, "provider-homes");

afterEach(() => {
  rmSync(stateFile, { force: true });
  rmSync(homesDir, { recursive: true, force: true });
});

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
