// Publishes a staged UI build (scripts/build.sh) into ui/dist and prunes the
// files of old builds.
//
// Bun names every chunk by its hash, so each build adds new files to ui/dist.
// An open tab never reloads on a new build and imports the lazy chunks of the
// build it loaded (mermaid, katex) long after the next one. The prune keeps
// the current and the previous build and every file written in the last 24 h,
// and removes the rest.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PublishResult = {
  // Relative paths, in the order they were renamed into place.
  published: string[];
  // Relative paths removed by the prune.
  removed: string[];
};

const MANIFEST = ".build-manifest.json";
const STAGE_PREFIX = ".dist-stage.";
const GRACE_MS = 24 * 3_600_000;
// Renamed into place after every other file, in this order, so the new entry
// appears only once every chunk it imports is there.
const ENTRY_FILES = ["index.js", "index.html"];

type Manifest = { current: string[]; previous: string[] };

function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      out.push(...filesUnder(join(dir, entry.name), rel + "/"));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// null when there is no manifest or it does not parse: the prune then does
// nothing, so a box updating from a build without one keeps its previous
// build for the tabs that still use it.
function readManifest(distDir: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(distDir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
  const isList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  if (typeof parsed !== "object" || parsed === null) return null;
  const { current, previous } = parsed as Record<string, unknown>;
  if (!isList(current) || !isList(previous)) return null;
  return { current, previous };
}

function writeManifest(distDir: string, manifest: Manifest) {
  const temporary = join(distDir, `${MANIFEST}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(manifest) + "\n");
  renameSync(temporary, join(distDir, MANIFEST));
}

// The cleanup only warns on an error: the new build is already live, and a
// failed build:ui makes scripts/update.sh roll the update back.
function tryRemove(path: string, remove: () => void): boolean {
  try {
    remove();
    return true;
  } catch (err) {
    console.warn(`publish-ui-dist: could not remove ${path}: ${String(err)}`);
    return false;
  }
}

// A build killed before its trap ran leaves its stage dir beside ui/dist.
function removeStaleStageDirs(stageDir: string, distDir: string, now: number) {
  const parent = dirname(resolve(distDir));
  const own = resolve(stageDir);
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    const path = join(parent, name);
    if (path === own) continue;
    tryRemove(path, () => {
      const stat = lstatSync(path);
      if (stat.isDirectory() && stat.mtimeMs < now - GRACE_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    });
  }
}

// lstat-based walk: a symlink is removed as a link and never followed.
// Two builds at once: this prune can remove a file the other build has just
// renamed in only when the file is older than 24 h and in neither list.
function prune(
  distDir: string,
  keep: Set<string>,
  now: number,
  prefix = "",
): string[] {
  const removed: string[] = [];
  const dir = join(distDir, prefix);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...prune(distDir, keep, now, rel + "/"));
      if (readdirSync(path).length === 0) tryRemove(rel, () => rmdirSync(path));
      continue;
    }
    if (rel === MANIFEST || keep.has(rel)) continue;
    if (lstatSync(path).mtimeMs >= now - GRACE_MS) continue;
    if (tryRemove(rel, () => unlinkSync(path))) removed.push(rel);
  }
  return removed;
}

export function publishUiDist(
  stageDir: string,
  distDir: string,
  now = Date.now(),
): PublishResult {
  removeStaleStageDirs(stageDir, distDir, now);
  mkdirSync(distDir, { recursive: true });
  const old = readManifest(distDir);

  const staged = filesUnder(stageDir).sort();
  const order = [
    ...staged.filter((rel) => !ENTRY_FILES.includes(rel)),
    ...ENTRY_FILES.filter((rel) => staged.includes(rel)),
  ];
  const published: string[] = [];
  for (const rel of order) {
    const target = join(distDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(stageDir, rel), target);
    published.push(rel);
  }

  // The same build again (an installer re-run) keeps the build before it as
  // the previous one.
  const stagedSet = new Set(staged);
  const rebuilt =
    old !== null &&
    old.current.length === staged.length &&
    old.current.every((rel) => stagedSet.has(rel));
  const previous = rebuilt ? old.previous : (old?.current ?? []);
  writeManifest(distDir, { current: staged, previous });
  const removed = old
    ? prune(distDir, new Set([...stagedSet, ...previous]), now)
    : [];
  return { published, removed };
}

if (import.meta.main) {
  const [stageDir, distDir] = process.argv.slice(2);
  if (!stageDir || !distDir) {
    console.error(
      "Usage: bun run scripts/publish-ui-dist.ts STAGE_DIR DIST_DIR",
    );
    process.exit(2);
  }
  publishUiDist(stageDir, distDir);
}
