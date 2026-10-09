import { afterEach, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSkillCatalog,
  deleteSkillFile,
  findCatalogEntry,
  readSkillFile,
  type SkillEngineContext,
} from "./skill-catalog.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isomux-skill-delete-"));
  roots.push(root);
  const user = join(root, "user");
  const project = join(root, "project");
  const context: SkillEngineContext = {
    engine: "claude",
    userRoots: [{ root: user, includeCommands: true }],
    cwds: [project],
    pluginRoot: join(root, "plugins-home"),
  };
  const put = (
    path: string,
    content = "---\nname: fixture\ndescription: fixture\n---\nBody\n",
  ) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const entry = (path: string) => {
    const e = findCatalogEntry(
      buildSkillCatalog([context], {}, user, root),
      path,
    );
    if (!e) throw new Error(`not in catalog: ${path}`);
    return e;
  };
  const rev = (path: string) => {
    const r = readSkillFile(path);
    if (r.kind !== "ok") throw new Error(r.kind);
    return r.rev;
  };
  return { root, user, project, context, put, entry, rev };
}

it("deletes user and project skill folders with resources, preserving siblings and child-link targets", async () => {
  const f = fixture();
  const outside = f.put(join(f.root, "outside", "keep.txt"), "keep");
  for (const base of [f.user, join(f.project, ".claude")]) {
    const path = f.put(join(base, "skills", "mine", "SKILL.md"));
    f.put(join(dirname(path), "scripts", "run.sh"), "script");
    symlinkSync(dirname(outside), join(dirname(path), "resources"));
    symlinkSync(outside, join(dirname(path), "resource.txt"));
    const sibling = f.put(join(base, "skills", "sibling", "SKILL.md"));
    expect(
      await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
    ).toEqual({ kind: "ok" });
    expect(existsSync(dirname(path))).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  }
});

it("unlinks a linked skill folder and invalidates its revision even when the same target is linked again", async () => {
  const f = fixture();
  const target = f.put(join(f.root, "target", "SKILL.md"));
  const folder = join(f.user, "skills", "linked");
  mkdirSync(dirname(folder), { recursive: true });
  symlinkSync(dirname(target), folder);
  const path = join(folder, "SKILL.md");
  const entry = f.entry(path),
    rev = f.rev(path);
  expect(await deleteSkillFile(entry, rev, [f.context])).toEqual({
    kind: "ok",
  });
  expect(existsSync(folder)).toBe(false);
  expect(existsSync(target)).toBe(true);
  symlinkSync(dirname(target), folder);
  expect(await deleteSkillFile(f.entry(path), rev, [f.context])).toMatchObject({
    kind: "stale",
  });
  expect(lstatSync(folder).isSymbolicLink()).toBe(true);
});

it("removes a skill folder whose SKILL.md is linked without removing the linked file", async () => {
  const f = fixture();
  const target = f.put(join(f.root, "target.md"));
  const path = join(f.user, "skills", "linked-file", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  expect(
    await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
  ).toEqual({ kind: "ok" });
  expect(existsSync(dirname(path))).toBe(false);
  expect(existsSync(target)).toBe(true);
});

it("deletes only a legacy command file and unlinks a linked command without its target", async () => {
  const f = fixture();
  const path = f.put(join(f.user, "commands", "mine.md"), "Legacy body");
  const sibling = f.put(join(dirname(path), "sibling.md"));
  expect(
    await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
  ).toEqual({ kind: "ok" });
  expect(existsSync(sibling)).toBe(true);
  symlinkSync(sibling, path);
  expect(
    await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
  ).toEqual({ kind: "ok" });
  expect(existsSync(path)).toBe(false);
  expect(existsSync(sibling)).toBe(true);
});

it("refuses stale and deleted files without removing resources", async () => {
  const f = fixture();
  const path = f.put(join(f.user, "skills", "mine", "SKILL.md"));
  const entry = f.entry(path),
    rev = f.rev(path);
  f.put(path, "Changed file, longer body\n");
  expect(await deleteSkillFile(entry, rev, [f.context])).toMatchObject({
    kind: "stale",
  });
  expect(existsSync(path)).toBe(true);
  rmSync(path);
  expect(await deleteSkillFile(entry, rev, [f.context])).toEqual({
    kind: "deleted",
  });
  expect(existsSync(dirname(path))).toBe(true);
});

it("protects plugin files and folders, including a linked folder with an unprotected SKILL.md target", async () => {
  const f = fixture();
  const plugin = join(f.root, "plugin");
  const pluginPath = f.put(join(plugin, "skills", "provided", "SKILL.md"));
  f.put(
    join(f.context.pluginRoot, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { fixture: [{ installPath: plugin }] } }),
  );
  const linkedFolder = join(f.user, "skills", "provided");
  mkdirSync(dirname(linkedFolder), { recursive: true });
  symlinkSync(dirname(pluginPath), linkedFolder);
  const path = join(linkedFolder, "SKILL.md");
  expect(f.entry(path).editable).toBe(false);
  expect(
    await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
  ).toEqual({ kind: "read_only" });
  const external = f.put(join(f.root, "external.md"));
  rmSync(pluginPath);
  symlinkSync(external, pluginPath);
  expect(f.entry(path).editable).toBe(true); // File protection alone cannot protect this folder.
  expect(
    await deleteSkillFile(f.entry(path), f.rev(path), [f.context]),
  ).toEqual({ kind: "read_only" });
  expect(lstatSync(linkedFolder).isSymbolicLink()).toBe(true);
  expect(existsSync(pluginPath)).toBe(true);
  expect(existsSync(external)).toBe(true);
});
