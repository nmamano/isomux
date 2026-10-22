// Every Bun the repository builds or tests with is the one package.json
// declares in "packageManager". CI, install.sh, update.sh and release.sh read
// that field; the Docker images and the remote CI toolchain carry their own
// copy, and a copy that drifts ships a Bun nobody tested (the provisioner and
// storefront images stayed on 1.3.11 through the 1.4.2 bump, task 11024a02).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function declared(): string {
  const pm = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).packageManager;
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pm);
  if (!m)
    throw new Error(`package.json packageManager is not bun@x.y.z: ${pm}`);
  return m[1];
}

type Ref = { file: string; tag: string; digest: string | null };

function dockerRefs(): Ref[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter((f) => basename(f).endsWith("Dockerfile"));
  const refs: Ref[] = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(
      /oven\/bun:([^\s@]+)(?:@(sha256:[0-9a-f]{64}))?/g,
    )) {
      refs.push({ file, tag: m[1], digest: m[2] ?? null });
    }
  }
  return refs;
}

test("every oven/bun image is the declared Bun, pinned by digest", () => {
  const version = declared();
  const refs = dockerRefs();
  const files = [...new Set(refs.map((r) => r.file))];
  // The scan reaches the office image and the provisioner image.
  expect(files).toContain("deploy/container/Dockerfile");
  expect(files).toContain("control-plane/deploy/Dockerfile");

  // A tag is the version, optionally followed by a variant (1.4.4-slim).
  expect(
    refs.map((r) => ({ file: r.file, version: r.tag.split("-")[0] })),
  ).toStrictEqual(refs.map((r) => ({ file: r.file, version })));
  expect(refs.filter((r) => r.digest === null)).toStrictEqual([]);

  // One tag resolves to one image everywhere it is used.
  const byTag = new Map<string, Set<string>>();
  for (const r of refs)
    byTag.set(r.tag, (byTag.get(r.tag) ?? new Set()).add(r.digest ?? ""));
  const split = [...byTag]
    .filter(([, digests]) => digests.size > 1)
    .map(([tag]) => tag);
  expect(split).toStrictEqual([]);
});

test("the remote CI toolchain installs the declared Bun", () => {
  const script = readFileSync(join(ROOT, "scripts/ci-remote.sh"), "utf8");
  const pinned = /^BUN_VERSION=(\S+)$/m.exec(script);
  expect(pinned).not.toBeNull();
  expect(pinned![1]).toBe(declared());
});
