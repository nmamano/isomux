// The credential file's shape, and the rule that a child's bytes never leave
// as themselves.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HOBBY_UPLOAD_BYTES,
  HOBBY_UPLOAD_FILES,
  SETTINGS_OF_INTEREST,
  inspectTokenFile,
  tokenFileUsable,
  versionFrom,
} from "./vercel-capability.ts";

/** Shaped like a Vercel token and published here, so a leak is an observation. */
const CANARY = "isomuxD3PublicCanary0123456789ab";

function withFile(
  contents: string,
  mode: number,
  fn: (file: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-token-"));
  const file = path.join(dir, "vercel.token");
  fs.writeFileSync(file, contents, { mode });
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the credential file", () => {
  test("one line at 0600 is usable, with or without the final newline", () => {
    for (const contents of [CANARY, `${CANARY}\n`]) {
      withFile(contents, 0o600, (file) => {
        const { checks, token } = inspectTokenFile(file);
        expect(tokenFileUsable(checks)).toBe(true);
        expect(token).toBe(CANARY);
      });
    }
  });

  test("A LOOSER MODE IS A REFUSAL, AND THE TOKEN IS WITHHELD", () => {
    // 0400 passes a "no group or world bits" test and must fail this one: the
    // mode is compared, not sampled.
    for (const mode of [0o644, 0o400, 0o660]) {
      withFile(CANARY, mode, (file) => {
        const { checks, token } = inspectTokenFile(file);
        expect({ mode, usable: tokenFileUsable(checks), token }).toEqual({
          mode,
          usable: false,
          token: "",
        });
      });
    }
  });

  test("anything but one bare line is refused", () => {
    for (const contents of [
      "",
      "\n",
      `export VERCEL_TOKEN=${CANARY}\n`,
      `${CANARY} \n`,
      `${CANARY}\nextra\n`,
      ` ${CANARY}\n`,
    ]) {
      withFile(contents, 0o600, (file) => {
        const { checks, token } = inspectTokenFile(file);
        expect({ contents, usable: tokenFileUsable(checks), token }).toEqual({
          contents,
          usable: false,
          token: "",
        });
      });
    }
  });

  test("a symlink cannot be opened at all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-token-"));
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.writeFileSync(real, CANARY, { mode: 0o600 });
    fs.symlinkSync(real, link);
    const { checks, token } = inspectTokenFile(link);
    expect(tokenFileUsable(checks)).toBe(false);
    expect(token).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("absent is the one case that is not 'something is there'", () => {
    const { checks } = inspectTokenFile(
      path.join(os.tmpdir(), "d3-token-does-not-exist", "vercel.token"),
    );
    expect(checks.present).toBe(false);
  });
});

describe("what a child's output may become", () => {
  test("only a version-shaped match leaves, never the bytes", () => {
    expect(versionFrom("Vercel CLI 58.9.1")).toBe("58.9.1");
    // A child that prints a credential instead of a version yields nothing.
    expect(versionFrom(`error: token ${CANARY} rejected`)).toBe("unreadable");
    expect(versionFrom("")).toBe("unreadable");
  });
});

describe("the caps the plan is measured against", () => {
  test("Vercel's Hobby upload ceilings, as published", () => {
    expect(HOBBY_UPLOAD_FILES).toBe(15_000);
    expect(HOBBY_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  test("the monorepo posture's two settings are named explicitly", () => {
    expect(SETTINGS_OF_INTEREST).toContain("rootDirectory");
    expect(SETTINGS_OF_INTEREST).toContain("sourceFilesOutsideRootDirectory");
  });
});
