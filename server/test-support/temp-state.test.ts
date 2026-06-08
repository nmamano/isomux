import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { assertSafeToDelete, removeStateDir } from "./temp-state.ts";

describe("assertSafeToDelete", () => {
  it("allows a freshly-created dir under the OS temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-guard-ok-"));
    try {
      expect(() => assertSafeToDelete(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the real ~/.isomux", () => {
    expect(() => assertSafeToDelete(join(homedir(), ".isomux"))).toThrow(
      /real isomux state root/,
    );
  });

  it("refuses the OS temp dir root itself (must be strictly under)", () => {
    expect(() => assertSafeToDelete(tmpdir())).toThrow(/not strictly under/);
  });

  it("refuses an arbitrary non-temp path", () => {
    expect(() => assertSafeToDelete(homedir())).toThrow(/not strictly under/);
  });

  it("does not mistake a sibling like /tmpx for being under /tmp", () => {
    // Append to the last segment of the real temp dir so the string shares the
    // prefix without a separator boundary (e.g. /tmp -> /tmpx).
    const sibling = realpathSync(tmpdir()) + "x-not-temp/inner";
    expect(() => assertSafeToDelete(sibling)).toThrow(/not strictly under/);
  });

  it("refuses a temp symlink that resolves to the real ~/.isomux (when present)", () => {
    // The named invariant: even reached via a symlink, the real state root is
    // refused. Only exercisable when ~/.isomux exists, since the guard follows
    // the link via realpath (it does on any machine actually running isomux).
    const realIsomux = join(homedir(), ".isomux");
    if (!existsSync(realIsomux)) return;
    const base = mkdtempSync(join(tmpdir(), "isomux-guard-isomux-"));
    const link = join(base, "to-isomux");
    try {
      symlinkSync(realIsomux, link);
      expect(() => assertSafeToDelete(link)).toThrow(/real isomux state root/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("follows symlinks: a temp symlink escaping the temp dir is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "isomux-guard-link-"));
    const link = join(base, "escape");
    try {
      symlinkSync(homedir(), link); // points outside the temp dir
      expect(() => assertSafeToDelete(link)).toThrow(/not strictly under/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("removeStateDir", () => {
  it("removes a populated temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-guard-rm-"));
    writeFileSync(join(dir, "file.txt"), "x");
    removeStateDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("is a no-op on an already-absent temp path", () => {
    const dir = join(tmpdir(), `isomux-guard-absent-${Date.now()}`);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeStateDir(dir)).not.toThrow();
  });

  it("refuses to remove the real ~/.isomux", () => {
    expect(() => removeStateDir(join(homedir(), ".isomux"))).toThrow(
      /real isomux state root/,
    );
  });
});
