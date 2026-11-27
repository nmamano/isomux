// The runtime of a member runner (internal-docs/member-os-user-design.md,
// section 1.1): the runner bundle (agent-runner/member-main.ts), a copy of
// Bun and the engine packages, in <share>/runtime/<hash>/, with
// runtime/current naming the one in use. The server writes it as the office
// user, so the member cannot change the code that its runner runs.
//
// The office builds the bundle at the first member connect, once per
// process; an office with no isolated member never builds it.

import { createHash, randomBytes } from "crypto";
import { readdirSync, lstatSync } from "fs";
import * as fsp from "fs/promises";
import { constants } from "fs";
import { dirname, join, relative, sep } from "path";
import {
  resolveCodexLauncherPath,
  CLAUDE_NATIVE_BIN,
} from "./engine-binaries.ts";
import {
  OpenCodeUnsupportedHostError,
  openCodeUnsupportedReason,
  resolveOpenCodeBinary,
} from "./backends/opencode/runtime.ts";
import {
  checkMemberShare,
  RUNTIME_HASH_PATTERN,
  type ShareProbe,
} from "./member-share-check.ts";
import { RUNTIME_ROOT } from "./runtime-root.ts";

// In the container the image keeps no /var/lib: the shares live on the data
// volume (deploy/container/member-users.py).
const DEFAULT_SHARE_ROOT =
  process.env.ISOMUX_APP_SUPERVISOR === "container"
    ? "/var/data/members/share"
    : "/var/lib/isomux-share";
let shareRoot = DEFAULT_SHARE_ROOT;

// The member share: <root>/<osuser>. Root is /var/lib/isomux-share, or
// /var/data/members/share in the container; tests set another.
export function memberSharePath(osUserName: string): string {
  return join(shareRoot, osUserName);
}

// The bin folder of the member's runtime in use: runtime/current, which
// holds BUN_NAME. Their apps' PATH names it.
export function memberRuntimeBinDir(osUserName: string): string {
  return join(memberSharePath(osUserName), "runtime", "current");
}

export function setMemberShareRoot(root: string | null): void {
  shareRoot = root ?? DEFAULT_SHARE_ROOT;
}

const MEMBER_MAIN = join(import.meta.dir, "agent-runner", "member-main.ts");
const NODE_MODULES = join(RUNTIME_ROOT, "node_modules");
export const BUNDLE_NAME = "runner.js";
export const BUN_NAME = "bun";
// The Codex safety hook (backends/codex/safety-hook-install.ts), which the
// member's Codex runs as the member.
export const CODEX_HOOK_REL = "bin/isomux-codex-safety-hook";

// The hook path that a member's Codex config names: through runtime/current,
// so the path (and Codex's trust hash of it) stays the same across runtime
// updates.
export function memberCodexHookPath(share: string): string {
  return join(share, "runtime", "current", CODEX_HOOK_REL);
}

// `path`, an office engine file, relative to the office's node_modules.
function engineRel(path: string): string {
  const rel = relative(NODE_MODULES, path);
  if (rel.startsWith("..") || rel.startsWith(sep))
    throw new Error(`${path} is not in ${NODE_MODULES}`);
  return rel;
}

function packageOf(rel: string): string {
  const parts = rel.split(sep);
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// The engine packages a member runtime holds, relative to node_modules: the
// Claude native package, the Codex launcher and its platform packages, and
// the OpenCode package of this host, if it has one.
export function enginePackages(): string[] {
  const packages = new Set<string>([
    packageOf(engineRel(CLAUDE_NATIVE_BIN)),
    packageOf(engineRel(resolveCodexLauncherPath())),
  ]);
  for (const name of readdirSync(join(NODE_MODULES, "@openai")))
    if (name.startsWith("codex-")) packages.add(`@openai/${name}`);
  try {
    packages.add(packageOf(engineRel(resolveOpenCodeBinary())));
  } catch (error) {
    if (!(error instanceof OpenCodeUnsupportedHostError)) throw error;
  }
  return [...packages].sort();
}

export interface MemberRuntimePaths {
  dir: string;
  bun: string;
  bundle: string;
  claudeBin: string;
  codexLauncher(): string;
  openCodeBin(platform?: NodeJS.Platform): string;
  ptySidecarArgv: string[];
  openCodeHelperArgv: string[];
}

// The engine paths in runtime folder `dir`: the office's own paths moved
// from its node_modules to dir/node_modules.
export function memberRuntimePaths(dir: string): MemberRuntimePaths {
  const modules = join(dir, "node_modules");
  const bun = join(dir, BUN_NAME);
  const bundle = join(dir, BUNDLE_NAME);
  return {
    dir,
    bun,
    bundle,
    claudeBin: join(modules, engineRel(CLAUDE_NATIVE_BIN)),
    codexLauncher: () => join(modules, engineRel(resolveCodexLauncherPath())),
    openCodeBin: (platform = process.platform) => {
      const unsupported = openCodeUnsupportedReason(platform);
      if (unsupported) throw new OpenCodeUnsupportedHostError(unsupported);
      return join(modules, engineRel(resolveOpenCodeBinary(platform)));
    },
    ptySidecarArgv: [bun, bundle, "pty"],
    openCodeHelperArgv: [bun, bundle, "opencode-helper"],
  };
}

export interface ManifestEntry {
  // Relative to node_modules.
  rel: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Changes with any byte of the bundle or of Bun, and with the path, size,
// mode or mtime of any engine file, so a reinstall of the same version with
// other bytes gives a new hash.
export function runtimeHash(input: {
  bundle: Uint8Array;
  bun: Uint8Array;
  manifest: ManifestEntry[];
  // The sha256 of the Codex safety hook, or null for none.
  codexHook?: string | null;
}): string {
  const hash = createHash("sha256");
  hash.update("isomux-member-runtime 1\n");
  hash.update(`bundle ${sha256(input.bundle)}\n`);
  hash.update(`bun ${sha256(input.bun)}\n`);
  // Absent from the input: the hash of a runtime made before the hook.
  if (input.codexHook !== undefined)
    hash.update(`codex-hook ${input.codexHook ?? "none"}\n`);
  for (const entry of [...input.manifest].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  ))
    hash.update(
      `${entry.rel}\0${entry.size}\0${entry.mode.toString(8)}\0${entry.mtimeMs}\n`,
    );
  return hash.digest("hex");
}

// Every regular file under node_modules/<pkg>. Any other kind of entry (a
// link, a socket) fails: the install copies only files and folders and never
// follows a link.
export function engineManifest(
  packages: string[],
  modules: string = NODE_MODULES,
): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const walk = (rel: string) => {
    const path = join(modules, rel);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(rel, name));
      return;
    }
    if (!st.isFile())
      throw new Error(
        `${path} is not a file or folder; a member runtime takes only files and folders`,
      );
    out.push({
      rel,
      size: st.size,
      mode: st.mode & 0o7777,
      mtimeMs: st.mtimeMs,
    });
  };
  for (const pkg of packages) walk(pkg);
  return out;
}

export interface RuntimeSource {
  hash: string;
  bundle: Uint8Array;
  // The Bun executable to install (the office's own).
  bunPath: string;
  // The node_modules folder the manifest is relative to.
  modules: string;
  manifest: ManifestEntry[];
  // The Codex safety hook artifact, or null when it did not build (then
  // the member's Codex is refused, and this source is not kept).
  codexHook: CodexHookArtifact | null;
}

export interface CodexHookArtifact {
  path: string;
  sha256: string;
}

export async function buildRunnerBundle(): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [MEMBER_MAIN],
    target: "bun",
    // runtime-root.ts: engine packages next to the bundle.
    define: { ISOMUX_MEMBER_BUNDLE: "true" },
  });
  const entries = result.outputs.filter((o) => o.kind === "entry-point");
  if (!result.success || entries.length !== 1 || result.outputs.length !== 1)
    throw new Error(
      `the member runner bundle did not build: ${result.logs.map(String).join("; ") || `${result.outputs.length} outputs`}`,
    );
  return new Uint8Array(await entries[0].arrayBuffer());
}

export interface MemberRuntimeDeps {
  build: () => Promise<Uint8Array>;
  bunPath: string;
  modules: string;
  packages: () => string[];
  // The prepared Codex safety hook; rejects while it does not build.
  codexHook: () => Promise<CodexHookArtifact>;
}

const DEFAULT_RUNTIME_DEPS: MemberRuntimeDeps = {
  build: buildRunnerBundle,
  bunPath: process.execPath,
  modules: NODE_MODULES,
  packages: enginePackages,
  // Read at each build: the server registers the source at boot.
  codexHook: () =>
    codexHookSource
      ? codexHookSource()
      : Promise.reject(new Error("no Codex safety hook source is registered")),
};
let runtimeDeps = DEFAULT_RUNTIME_DEPS;
let source: Promise<RuntimeSource> | null = null;
let codexHookSource: (() => Promise<CodexHookArtifact>) | null = null;

// The prepared Codex safety hook (backends/codex/safety-hook-install.ts
// codexHookArtifact), which startServer registers: this module does not
// import the engine. null clears it. Until one is registered, a built source
// has no hook and is not kept.
export function setMemberRuntimeCodexHook(
  hook: (() => Promise<CodexHookArtifact>) | null,
): void {
  codexHookSource = hook;
}

// Tests: replace some dependencies and forget the cached source; null
// restores the defaults.
export function setMemberRuntimeDeps(
  over: Partial<MemberRuntimeDeps> | null,
): void {
  runtimeDeps = over
    ? { ...DEFAULT_RUNTIME_DEPS, ...over }
    : DEFAULT_RUNTIME_DEPS;
  source = null;
}

// The runtime this server installs, built once per process. A failure is
// not kept: the next connect tries again. Neither is a source without the
// Codex hook (its build failed): the next call builds again, so a member's
// Codex is refused only while the hook does not build.
export function runtimeSource(): Promise<RuntimeSource> {
  if (!source) {
    const deps = runtimeDeps;
    const made = (async (): Promise<RuntimeSource> => {
      const bundle = await deps.build();
      const manifest = engineManifest(deps.packages(), deps.modules);
      const bun = await Bun.file(deps.bunPath).bytes();
      let codexHook: CodexHookArtifact | null = null;
      try {
        codexHook = await deps.codexHook();
      } catch (error) {
        console.error(
          `[member-runtime] the Codex safety hook is not in this runtime: ${(error as Error).message}`,
        );
      }
      return {
        hash: runtimeHash({
          bundle,
          bun,
          manifest,
          codexHook: codexHook?.sha256 ?? null,
        }),
        bundle,
        bunPath: deps.bunPath,
        modules: deps.modules,
        manifest,
        codexHook,
      };
    })();
    source = made;
    made.then(
      (built) => {
        if (built.codexHook === null && source === made) source = null;
      },
      () => {
        if (source === made) source = null;
      },
    );
  }
  return source;
}

// The file operations of an install; tests replace link to force a copy.
export interface RuntimeFs {
  link(src: string, dst: string): Promise<void>;
}

const realRuntimeFs: RuntimeFs = { link: (src, dst) => fsp.link(src, dst) };

const LINK_FALLBACK = new Set(["EXDEV", "EPERM", "EACCES", "EMLINK"]);

// One file into the runtime. A hard link of the office's file when its mode
// gives no group or other write and no setuid or setgid bit (a link shares
// the inode and its mode); else a copy with mode 0755 or 0644 that keeps
// the source mtime.
async function place(
  src: string,
  dst: string,
  fs: RuntimeFs,
): Promise<"link" | "copy"> {
  const st = await fsp.lstat(src);
  if (!st.isFile())
    throw new Error(`${src} is not a file; a member runtime takes only files`);
  const mode = st.mode & 0o7777;
  if ((mode & 0o6000) === 0 && (mode & 0o022) === 0) {
    try {
      await fs.link(src, dst);
      return "link";
    } catch (error) {
      if (!LINK_FALLBACK.has((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  await fsp.copyFile(src, dst, constants.COPYFILE_EXCL);
  await fsp.chmod(dst, mode & 0o111 ? 0o755 : 0o644);
  await fsp.utimes(dst, st.atime, st.mtime);
  return "copy";
}

// A folder the member may read: made 0755 (a umask only removes bits, so
// it is never writable by the member's group, which a setgid share gives
// it), then chmod 0755 so a narrow umask does not take read away.
async function makeDir(path: string, mode = 0o755): Promise<void> {
  await fsp.mkdir(path, { mode });
  await fsp.chmod(path, mode);
}

// The copy of the office's CA bundle in a member's share, which their
// agents' CA variables name (secret-proxy/runtime.ts, CA_BUNDLE_VARIABLES).
export function memberCaBundlePath(share: string): string {
  return join(share, "secrets", "ca-bundle.pem");
}

// True when `pem` holds certificates and nothing else: no key of the office
// CA may reach a share.
export function certificatesOnly(pem: string): boolean {
  const blocks = pem.match(/-----BEGIN [^\n]*-----/g) ?? [];
  return (
    blocks.length > 0 &&
    blocks.every((line) => line === "-----BEGIN CERTIFICATE-----") &&
    !/PRIVATE KEY/.test(pem)
  );
}

// Writes `pem` to memberCaBundlePath(share), 0644 in secrets/ (0755), both
// the office's: a temp file, then a rename. Throws, and writes nothing, when
// `pem` holds anything but certificates.
export async function writeMemberCaBundle(
  share: string,
  pem: string,
): Promise<void> {
  if (!certificatesOnly(pem))
    throw new Error("the CA bundle holds more than certificates");
  const target = memberCaBundlePath(share);
  const dir = dirname(target);
  try {
    await makeDir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = await fsp.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await fsp.writeFile(tmp, pem, { mode: 0o644, flag: "wx" });
    await fsp.chmod(tmp, 0o644);
    await fsp.rename(tmp, target);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// One install per share at a time.
const installs = new Map<string, Promise<unknown>>();

export interface InstallResult {
  hash: string;
  dir: string;
  // False when runtime/<hash> was there and passed the check.
  written: boolean;
}

export interface InstallOptions {
  officeUid?: number;
  memberGid: number;
  fs?: RuntimeFs;
  probe?: ShareProbe;
}

// Install `src` in <share>/runtime/<hash>/ (a temp folder, then a rename)
// and point runtime/current at it. A runtime/<hash> that exists and passes
// the share check is kept as it is; one that fails is replaced. Nothing is
// pruned here (pruneMemberRuntime).
export async function installMemberRuntime(
  share: string,
  src: RuntimeSource,
  options: InstallOptions,
): Promise<InstallResult> {
  const before = installs.get(share) ?? Promise.resolve();
  const run = before
    .catch(() => {})
    .then(() => installNow(share, src, options));
  installs.set(share, run);
  try {
    return await run;
  } finally {
    if (installs.get(share) === run) installs.delete(share);
  }
}

async function installNow(
  share: string,
  src: RuntimeSource,
  options: InstallOptions,
): Promise<InstallResult> {
  const fs = options.fs ?? realRuntimeFs;
  const runtime = join(share, "runtime");
  const dir = join(runtime, src.hash);
  try {
    await makeDir(runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await fsp.lstat(runtime)).isDirectory())
    throw new Error(`${runtime} is not a folder`);

  const existing = await fsp.lstat(dir).catch(() => null);
  if (existing) {
    const verdict = checkMemberShare({
      share,
      officeUid: options.officeUid ?? process.getuid!(),
      memberGid: options.memberGid,
      probe: options.probe,
      // Only this runtime: a bad old one must not cost a rewrite each try.
      scope: { runtime: src.hash },
    });
    if (verdict.ok && existing.isDirectory()) {
      await pointCurrent(runtime, src.hash);
      return { hash: src.hash, dir, written: false };
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // Closed while it is written: a copy starts with the source's bits and
  // the member's group, and an fd opened then would outlive the chmod.
  const tmp = join(runtime, `.tmp-${randomBytes(8).toString("hex")}`);
  await makeDir(tmp, 0o700);
  try {
    await fsp.writeFile(join(tmp, BUNDLE_NAME), src.bundle, {
      mode: 0o644,
      flag: "wx",
    });
    await fsp.chmod(join(tmp, BUNDLE_NAME), 0o644);
    await place(src.bunPath, join(tmp, BUN_NAME), fs);
    if (src.codexHook) {
      // Always a copy: the office's own file is 0700, and a hard link would
      // share that mode, which the member cannot run. 0755 as the other
      // executables here; the share (2750) keeps other users out.
      await makeDir(join(tmp, dirname(CODEX_HOOK_REL)));
      const hook = join(tmp, CODEX_HOOK_REL);
      await fsp.copyFile(src.codexHook.path, hook, constants.COPYFILE_EXCL);
      await fsp.chmod(hook, 0o755);
    }
    const made = new Set<string>([tmp]);
    const ensure = async (path: string) => {
      if (made.has(path)) return;
      await ensure(dirname(path));
      await makeDir(path);
      made.add(path);
    };
    const modules = join(tmp, "node_modules");
    for (const entry of src.manifest) {
      const dst = join(modules, entry.rel);
      await ensure(dirname(dst));
      await place(join(src.modules, entry.rel), dst, fs);
    }
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, dir);
  } catch (error) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await pointCurrent(runtime, src.hash);
  return { hash: src.hash, dir, written: true };
}

// runtime/current -> <hash>, switched by a rename.
async function pointCurrent(runtime: string, hash: string): Promise<void> {
  const current = join(runtime, "current");
  const now = await fsp.readlink(current).catch(() => null);
  if (now === hash) return;
  const next = join(runtime, `.current-${randomBytes(8).toString("hex")}`);
  await fsp.symlink(hash, next);
  try {
    await fsp.rename(next, current);
  } catch (error) {
    await fsp.rm(next, { force: true }).catch(() => {});
    throw error;
  }
}

// Remove every runtime folder but those in `keep` (the installed hash and
// the hash that the connected runner reports), and any temp left by a failed
// install. Called only after the runner reports the installed hash.
export async function pruneMemberRuntime(
  share: string,
  keep: string[],
): Promise<string[]> {
  const runtime = join(share, "runtime");
  let names: string[];
  try {
    names = await fsp.readdir(runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    const stale =
      (RUNTIME_HASH_PATTERN.test(name) && !keep.includes(name)) ||
      name.startsWith(".tmp-") ||
      name.startsWith(".current-");
    if (!stale) continue;
    await fsp.rm(join(runtime, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
