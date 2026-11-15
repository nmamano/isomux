// The member runtime (server/member-runtime.ts,
// internal-docs/member-os-user-design.md 1.1): the runner bundle, Bun and the
// engine packages, written by the office user into <share>/runtime/<hash>/.
// The properties: the hash follows every installed byte; an install links an
// office file only when the member can never write through the link, and
// copies it with safe bits otherwise; nothing the member can reach is
// writable while the install runs; a failed install changes nothing; the
// install is a no-op on a runtime that is there and passes the share check;
// the prune keeps what a runner may still run; and an office builds the
// bundle once, only for a member.
//
// The engine packages are a fake node_modules in a temp folder. The share
// check needs a root-owned parent, which a test user cannot make, so its
// probe reports the parent as root's; everything else is the real file
// system.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  engineManifest,
  installMemberRuntime,
  pruneMemberRuntime,
  runtimeHash,
  runtimeSource,
  setMemberRuntimeDeps,
  type ManifestEntry,
  type RuntimeFs,
  type RuntimeSource,
} from "./member-runtime.ts";
import {
  checkMemberShare,
  realShareProbe,
  type ShareProbe,
} from "./member-share-check.ts";
import { connectMemberHosts, resetMemberHosts } from "./member-hosts.ts";
import { memberOsUsersPath, reloadMemberOsUsers } from "./member-os-users.ts";
import { expectRejection } from "./test-support/expect-rejection.ts";

const GID = process.getgid!();
const PACKAGES = ["pkg-a", "@scope/pkg-b"];

let root: string;
let modules: string;
let share: string;
let bunFile: string;
let umask: number;

beforeEach(() => {
  // This box's umask (bun install left node_modules 0664 here): the install
  // must not depend on a 022 umask for safe bits.
  umask = process.umask(0o002);
  root = mkdtempSync(join(tmpdir(), "member-runtime-"));
  modules = join(root, "office", "node_modules");
  writeEngine("pkg-a/bin/tool", "tool\n", 0o755);
  writeEngine("pkg-a/lib/index.js", "index\n", 0o644);
  writeEngine("@scope/pkg-b/native", "native\n", 0o755);
  bunFile = join(root, "office", "bun");
  writeFileSync(bunFile, "bun bytes\n");
  chmodSync(bunFile, 0o755);
  const parent = join(root, "shares");
  mkdirSync(parent);
  chmodSync(parent, 0o755);
  share = join(parent, "isomux-alice");
  mkdirSync(share);
  chmodSync(share, 0o2750);
});

afterEach(() => {
  process.umask(umask);
  setMemberRuntimeDeps(null);
  rmSync(root, { recursive: true, force: true });
});

function writeEngine(rel: string, text: string, mode: number): string {
  const path = join(modules, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

function source(bundle = "bundle bytes\n"): RuntimeSource {
  const bytes = new TextEncoder().encode(bundle);
  const manifest = engineManifest(PACKAGES, modules);
  return {
    hash: runtimeHash({
      bundle: bytes,
      bun: readFileSync(bunFile),
      manifest,
    }),
    bundle: bytes,
    bunPath: bunFile,
    modules,
    manifest,
    codexHook: null,
  };
}

// The real probe, with the share's parent reported as root's.
const probe: ShareProbe = {
  lstat(path) {
    const entry = realShareProbe.lstat(path);
    return entry && path === dirname(share) ? { ...entry, uid: 0 } : entry;
  },
  readdir: (path) => realShareProbe.readdir(path),
};

// Every link the install asks for; `fail` makes it throw that code.
function recordingFs(fail?: (src: string) => string | null): RuntimeFs & {
  linked: string[];
} {
  const linked: string[] = [];
  return {
    linked,
    async link(src, dst) {
      linked.push(src);
      const code = fail?.(src);
      if (code) throw Object.assign(new Error(`${code}: test`), { code });
      const { link } = await import("fs/promises");
      await link(src, dst);
    },
  };
}

const install = (src: RuntimeSource, fs?: RuntimeFs) =>
  installMemberRuntime(share, src, { memberGid: GID, fs, probe });

const runtimeDir = (hash: string) => join(share, "runtime", hash);
const installed = (hash: string, rel: string) =>
  join(runtimeDir(hash), "node_modules", rel);
const ino = (path: string) => statSync(path).ino;
const modeOf = (path: string) => lstatSync(path).mode & 0o7777;
const current = () => readlinkSync(join(share, "runtime", "current"));
const runtimeNames = () => readdirSync(join(share, "runtime")).sort();

describe("runtimeHash", () => {
  const base = () => ({
    bundle: new Uint8Array([1, 2, 3]),
    bun: new Uint8Array([4, 5, 6]),
    manifest: [
      { rel: "pkg-a/bin/tool", size: 5, mode: 0o755, mtimeMs: 1000 },
      { rel: "pkg-a/lib/index.js", size: 6, mode: 0o644, mtimeMs: 2000 },
    ] as ManifestEntry[],
  });

  it("is the same for the same inputs, whatever the manifest order", () => {
    const a = base();
    const b = base();
    b.manifest.reverse();
    expect(runtimeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(runtimeHash(b)).toBe(runtimeHash(a));
  });

  const changes: [string, (input: ReturnType<typeof base>) => void][] = [
    ["one bundle byte", (i) => (i.bundle[1] = 9)],
    ["one Bun byte", (i) => (i.bun[2] = 9)],
    ["an engine file's path", (i) => (i.manifest[0].rel = "pkg-a/bin/other")],
    ["an engine file's size", (i) => (i.manifest[0].size = 6)],
    ["an engine file's mode", (i) => (i.manifest[1].mode = 0o664)],
    // A reinstall of the same version with other bytes.
    ["an engine file's mtime", (i) => (i.manifest[1].mtimeMs = 2001)],
    [
      "one engine file more",
      (i) =>
        i.manifest.push({ rel: "pkg-a/x", size: 0, mode: 0o644, mtimeMs: 0 }),
    ],
  ];
  for (const [name, change] of changes) {
    it(`changes with ${name}`, () => {
      const changed = base();
      change(changed);
      expect(runtimeHash(changed)).not.toBe(runtimeHash(base()));
    });
  }

  // Slice 2d-i: other hook bytes are another runtime folder, and a runtime
  // without the hook is not one with it.
  it("changes with the Codex hook's bytes, and with no hook", () => {
    const withHook = (codexHook: string | null) =>
      runtimeHash({ ...base(), codexHook });
    expect(withHook("a".repeat(64))).not.toBe(withHook("b".repeat(64)));
    expect(withHook(null)).not.toBe(withHook("a".repeat(64)));
  });
});

describe("engineManifest", () => {
  it("lists every regular file of the packages, relative to node_modules", () => {
    expect(
      engineManifest(PACKAGES, modules)
        .map((e) => e.rel)
        .sort(),
    ).toEqual(["@scope/pkg-b/native", "pkg-a/bin/tool", "pkg-a/lib/index.js"]);
  });

  it("refuses a link in a package rather than follow it", () => {
    symlinkSync(bunFile, join(modules, "pkg-a", "lib", "linked"));
    expect(() => engineManifest(PACKAGES, modules)).toThrow();
  });

  it("refuses a fifo in a package", () => {
    const made = spawnSync("mkfifo", [join(modules, "pkg-a", "pipe")]);
    expect(made.status).toBe(0);
    expect(() => engineManifest(PACKAGES, modules)).toThrow();
  });
});

describe("installMemberRuntime", () => {
  // Slice 2d-i: the office's hook artifact is 0700, which a link would keep
  // and the member could not run.
  it("carries the Codex hook as a copy the member can run, under runtime/current", async () => {
    const hookFile = join(root, "office", "hook");
    writeFileSync(hookFile, "hook bytes\n");
    chmodSync(hookFile, 0o700);
    const src = { ...source(), codexHook: { path: hookFile, sha256: "h" } };
    const fs = recordingFs();
    await install(src, fs);
    const hook = join(
      share,
      "runtime",
      "current",
      "bin",
      "isomux-codex-safety-hook",
    );
    expect(lstatSync(hook).isFile()).toBe(true);
    expect(statSync(hook).ino).not.toBe(ino(hookFile));
    expect(fs.linked).not.toContain(hookFile);
    expect(modeOf(hook)).toBe(0o755);
    expect(readFileSync(hook, "utf8")).toBe("hook bytes\n");
    expect(
      checkMemberShare({
        share,
        officeUid: process.getuid!(),
        memberGid: GID,
        probe,
      }),
    ).toEqual({ ok: true });
  });

  it("links the office's files, writes the bundle and points current at the hash", async () => {
    const src = source();
    const fs = recordingFs();
    const result = await install(src, fs);
    expect(result).toEqual({
      hash: src.hash,
      dir: runtimeDir(src.hash),
      written: true,
    });
    for (const rel of [
      "pkg-a/bin/tool",
      "pkg-a/lib/index.js",
      "@scope/pkg-b/native",
    ])
      expect(ino(installed(src.hash, rel))).toBe(ino(join(modules, rel)));
    expect(ino(join(runtimeDir(src.hash), "bun"))).toBe(ino(bunFile));
    expect(readFileSync(join(runtimeDir(src.hash), "runner.js"), "utf8")).toBe(
      "bundle bytes\n",
    );
    // A relative name of the hash, which the share check accepts.
    expect(current()).toBe(src.hash);
    expect(
      checkMemberShare({
        share,
        officeUid: process.getuid!(),
        memberGid: GID,
        probe,
      }),
    ).toEqual({ ok: true });
  });

  it("copies when a link is not possible, with safe bits and the source mtime", async () => {
    const past = new Date("2026-01-02T03:04:05Z");
    utimesSync(join(modules, "pkg-a/lib/index.js"), past, past);
    const src = source();
    await install(
      src,
      recordingFs(() => "EXDEV"),
    );
    for (const [rel, mode] of [
      ["pkg-a/bin/tool", 0o755],
      ["pkg-a/lib/index.js", 0o644],
      ["@scope/pkg-b/native", 0o755],
    ] as const) {
      const path = installed(src.hash, rel);
      expect(ino(path)).not.toBe(ino(join(modules, rel)));
      expect(modeOf(path)).toBe(mode);
      expect(readFileSync(path, "utf8")).toBe(
        readFileSync(join(modules, rel), "utf8"),
      );
    }
    expect(statSync(installed(src.hash, "pkg-a/lib/index.js")).mtimeMs).toBe(
      past.getTime(),
    );
  });

  for (const [name, mode, safe] of [
    // A link shares the inode: the member could write the office's own file.
    ["group write", 0o664, 0o644],
    ["other write", 0o646, 0o644],
    ["group write on an executable", 0o775, 0o755],
    // A link shares the mode: the member would run an office file with its ids.
    ["setuid", 0o4755, 0o755],
    ["setgid", 0o2755, 0o755],
  ] as const) {
    it(`never links an office file with ${name}; its copy has ${safe.toString(8)}`, async () => {
      const path = join(modules, "pkg-a/bin/tool");
      chmodSync(path, mode);
      // The enabling condition: the source really has those bits.
      expect(modeOf(path)).toBe(mode);
      const src = source();
      const fs = recordingFs();
      await install(src, fs);
      expect(fs.linked).not.toContain(path);
      expect(ino(installed(src.hash, "pkg-a/bin/tool"))).not.toBe(ino(path));
      expect(modeOf(installed(src.hash, "pkg-a/bin/tool"))).toBe(safe);
      // The other files are still links.
      expect(fs.linked).toContain(join(modules, "pkg-a/lib/index.js"));
    });
  }

  it("keeps the folder it builds closed to everyone but the office while it writes", async () => {
    const src = source();
    const seen: { folder: string; mode: number }[] = [];
    const fs: RuntimeFs = {
      async link(_src, dst) {
        // The build folder is the runtime/ entry this file is under.
        const rel = dst.slice(join(share, "runtime").length + 1);
        const folder = join(share, "runtime", rel.split("/")[0]);
        seen.push({ folder, mode: modeOf(folder) });
        throw Object.assign(new Error("EXDEV: test"), { code: "EXDEV" });
      },
    };
    await install(src, fs);
    // The enabling condition: the hook saw the build folder, not the result.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.folder !== runtimeDir(src.hash))).toBe(true);
    // No group or other access: under a setgid share the folder has the
    // member's group, and a copy is made with the source's bits first.
    expect(seen.map((s) => s.mode & 0o077)).toEqual(seen.map(() => 0));
    // The result is open to read.
    expect(modeOf(runtimeDir(src.hash)) & 0o055).toBe(0o055);
  });

  it("leaves no member-writable entry after an install under umask 002", async () => {
    const src = source();
    await install(
      src,
      recordingFs(() => "EXDEV"),
    );
    const walk = (path: string): string[] => {
      const st = lstatSync(path);
      const own = st.mode & 0o022 && !st.isSymbolicLink() ? [path] : [];
      return st.isDirectory()
        ? [...own, ...readdirSync(path).flatMap((n) => walk(join(path, n)))]
        : own;
    };
    expect(walk(join(share, "runtime"))).toEqual([]);
  });

  it("refuses a source file that is a link and changes nothing", async () => {
    const first = source();
    await install(first);
    // A manifest that names a link (the source changed under it).
    writeEngine("pkg-a/lib/new.js", "x\n", 0o644);
    const src = source("other bundle\n");
    rmSync(join(modules, "pkg-a/lib/new.js"));
    symlinkSync(bunFile, join(modules, "pkg-a/lib/new.js"));
    await expectRejection(install(src), /./);
    expect(existsSync(runtimeDir(src.hash))).toBe(false);
    expect(current()).toBe(first.hash);
    expect(runtimeNames()).toEqual(["current", first.hash].sort());
  });

  it("changes nothing when a write fails midway: no runtime folder, no temp, current as it was", async () => {
    const first = source();
    await install(first);
    const src = source("other bundle\n");
    let calls = 0;
    const failing = recordingFs(() => (++calls === 3 ? "EIO" : null));
    await expectRejection(install(src, failing), /EIO/);
    expect(calls).toBe(3);
    expect(existsSync(runtimeDir(src.hash))).toBe(false);
    expect(current()).toBe(first.hash);
    expect(runtimeNames()).toEqual(["current", first.hash].sort());
  });

  it("does nothing more on a runtime that is there and passes the share check", async () => {
    const src = source();
    await install(src);
    const fs = recordingFs();
    const result = await install(src, fs);
    expect(result.written).toBe(false);
    expect(fs.linked).toEqual([]);
    expect(current()).toBe(src.hash);
  });

  // A7: a bad old runtime fails the connect's full check after the install
  // (fail closed), but must not cost a rewrite of the wanted one each try.
  it("does not write again when only another runtime folder is bad", async () => {
    const src = source();
    await install(src);
    const old = join(share, "runtime", "9".repeat(64));
    mkdirSync(old);
    writeFileSync(join(old, "x"), "x\n");
    chmodSync(join(old, "x"), 0o666);
    // The enabling condition: the whole share fails the check.
    expect(
      checkMemberShare({
        share,
        officeUid: process.getuid!(),
        memberGid: GID,
        probe,
      }).ok,
    ).toBe(false);
    const fs = recordingFs();
    const result = await install(src, fs);
    expect(result.written).toBe(false);
    expect(fs.linked).toEqual([]);
  });

  it("points current back at a runtime that is there", async () => {
    const a = source();
    await install(a);
    const b = source("other bundle\n");
    await install(b);
    expect(current()).toBe(b.hash);
    const result = await install(a, recordingFs());
    expect(result.written).toBe(false);
    expect(current()).toBe(a.hash);
  });

  it("replaces a runtime that is there but fails the share check", async () => {
    const src = source();
    await install(
      src,
      recordingFs(() => "EXDEV"),
    );
    const bad = installed(src.hash, "pkg-a/lib/index.js");
    chmodSync(bad, 0o666);
    const fs = recordingFs(() => "EXDEV");
    const result = await install(src, fs);
    expect(result.written).toBe(true);
    expect(fs.linked.length).toBeGreaterThan(0);
    expect(modeOf(bad)).toBe(0o644);
  });
});

describe("pruneMemberRuntime", () => {
  it("removes every runtime and temp but the kept hashes, and leaves current and other names", async () => {
    const runtime = join(share, "runtime");
    const kept = "1".repeat(64);
    const running = "2".repeat(64);
    const stale = "3".repeat(64);
    for (const name of [kept, running, stale, ".tmp-abc", "notes"])
      mkdirSync(join(runtime, name), { recursive: true });
    writeFileSync(join(runtime, ".current-abc"), "");
    symlinkSync(kept, join(runtime, "current"));
    const removed = await pruneMemberRuntime(share, [kept, running]);
    expect(removed.sort()).toEqual([".current-abc", ".tmp-abc", stale].sort());
    expect(runtimeNames()).toEqual(["current", "notes", kept, running].sort());
  });

  it("is nothing on a share with no runtime folder", async () => {
    expect(await pruneMemberRuntime(share, [])).toEqual([]);
  });
});

describe("runtimeSource", () => {
  function counting(fail = false) {
    const state = { builds: 0 };
    setMemberRuntimeDeps({
      build: async () => {
        state.builds++;
        if (fail) throw new Error("build failed");
        return new TextEncoder().encode("bundle\n");
      },
      bunPath: bunFile,
      modules,
      packages: () => PACKAGES,
      codexHook: async () => ({ path: bunFile, sha256: "hook" }),
    });
    return state;
  }

  it("builds once per process", async () => {
    const state = counting();
    const [a, b] = await Promise.all([runtimeSource(), runtimeSource()]);
    const c = await runtimeSource();
    expect(state.builds).toBe(1);
    expect(b.hash).toBe(a.hash);
    expect(c.hash).toBe(a.hash);
    expect(a.manifest.map((e) => e.rel).sort()).toEqual([
      "@scope/pkg-b/native",
      "pkg-a/bin/tool",
      "pkg-a/lib/index.js",
    ]);
  });

  it("does not keep a failed build", async () => {
    const state = counting(true);
    await expectRejection(runtimeSource(), /build failed/);
    await expectRejection(runtimeSource(), /build failed/);
    expect(state.builds).toBe(2);
  });

  // Slice 2d-i: a member's Codex is refused only while the hook does not
  // build, not until the server restarts.
  it("does not keep a source without the Codex hook, and keeps the first one with it", async () => {
    const state = { builds: 0 };
    let hookBuilds = true;
    setMemberRuntimeDeps({
      build: async () => {
        state.builds++;
        return new TextEncoder().encode("bundle\n");
      },
      bunPath: bunFile,
      modules,
      packages: () => PACKAGES,
      codexHook: async () => {
        if (hookBuilds) throw new Error("hook build failed");
        return { path: bunFile, sha256: "hook" };
      },
    });
    const without = await runtimeSource();
    expect(without.codexHook).toBeNull();
    expect((await runtimeSource()).codexHook).toBeNull();
    expect(state.builds).toBe(2);
    hookBuilds = false;
    const withHook = await runtimeSource();
    expect(withHook.codexHook).toEqual({ path: bunFile, sha256: "hook" });
    expect(withHook.hash).not.toBe(without.hash);
    expect(await runtimeSource()).toBe(withHook);
    expect(state.builds).toBe(3);
  });

  it("is never built by an office with no isolated member", async () => {
    const state = counting();
    rmSync(memberOsUsersPath(), { force: true });
    reloadMemberOsUsers();
    try {
      await connectMemberHosts();
      expect(state.builds).toBe(0);
    } finally {
      resetMemberHosts();
    }
  });
});
