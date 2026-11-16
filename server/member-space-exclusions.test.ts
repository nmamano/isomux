// What the backup leaves out of an isolated member's agent space
// (internal-docs/member-os-user-design.md, slice 3c, D4 and E2). The
// properties:
// - every exclusion of the office's backup leaves out the same path in her
//   space, and everything under it (derived, never a copy);
// - a backend login name is left out at any depth (E2);
// - a regenerable LOCATION matches segment by segment: a folder of the same
//   name deep in her data stays;
// - what the backup keeps on purpose (the OpenCode database) stays;
// - the office's own list of regenerable paths is what it was before the
//   refactor.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BACKEND_CREDENTIAL_PATHS } from "./backend-credential-paths.ts";
import {
  BACKUP_EXCLUSIONS,
  REGENERABLE_LOCATIONS,
  regenerableBackupPaths,
} from "./backup-exclusions.ts";
import { memberSpaceExcluded } from "./member-space-exclusions.ts";
import { memberSpaceSkillFolderPath } from "./member-skill-folder.ts";

const ROOT = "R";
// One sample for a glob: "*" is a folder name, or several.
const samples = (glob: string) => [
  glob.replaceAll("*", "p1"),
  glob.replaceAll("*", "p1/p2"),
];
const officeGlobs = BACKUP_EXCLUSIONS.flatMap((entry) =>
  entry.archivePatterns(ROOT),
).map((glob) => glob.slice(ROOT.length + 1));

describe("the exclusions of her agent space", () => {
  it("leave out every path the office's backup leaves out, with what is under it", () => {
    const kept = officeGlobs
      .flatMap(samples)
      .flatMap((rel) => [rel, `${rel}/child`])
      .filter((rel) => !memberSpaceExcluded(rel));
    expect(kept).toEqual([]);
  });

  // MUTANT: the credential names are matched only at the rooted shapes.
  it("leave out each backend login name at any depth", () => {
    const deep = "provider-homes/u1/a/b/c";
    const sample: Record<string, string> = {
      "browser-profile": "browser-profiles/b1/storage-state.json",
      "claude-login": ".credentials.json",
      "codex-login": ".codex/auth.json",
      "opencode-login": ".local/share/opencode/auth.json",
      "opencode-mcp-login": ".local/share/opencode/mcp-auth.json",
      "opencode-isomux-config": "opencode/profiles/p1/opencode.json",
      "opencode-server-record": "opencode/profiles/p1/server.lock",
    };
    const ids = BACKEND_CREDENTIAL_PATHS.filter((e) => e.backup !== "keep").map(
      (e) => e.id,
    );
    // A new login entry needs a sample here.
    expect(ids.filter((id) => !(id in sample))).toEqual([]);
    const kept = ids
      .map((id) => `${deep}/${sample[id]}`)
      .filter((rel) => !memberSpaceExcluded(rel));
    expect(kept).toEqual([]);
  });

  it("leave out each regenerable location, and keep a folder of the same name deep in her data", () => {
    const at = REGENERABLE_LOCATIONS.map((l) => l.replaceAll("*", "p1"));
    expect(
      at
        .flatMap((rel) => [rel, `${rel}/x`])
        .filter((r) => !memberSpaceExcluded(r)),
    ).toEqual([]);
    // The same names, one level deeper than any location.
    const deeper = at.map((rel) => `apps/data/app1/${rel}/keep.txt`);
    expect(deeper.filter((rel) => memberSpaceExcluded(rel))).toEqual([]);
  });

  it("leave out what the office makes again in her space", () => {
    const space = "/home/isomux-alice/.isomux-agent";
    const skills = relative(
      space,
      memberSpaceSkillFolderPath(space, "claude", "/x/provider"),
    );
    expect(
      [
        skills,
        `${skills}/SKILL.md`,
        "apps/units/a.sh",
        "apps/secrets/a.json",
      ].filter((rel) => !memberSpaceExcluded(rel)),
    ).toEqual([]);
  });

  it("keep her own files, the OpenCode database and her transcripts", () => {
    const kept = [
      "provider-homes/u1/claude/projects/-tmp/s.jsonl",
      "opencode/profiles/p1/data/opencode/opencode-v2.db",
      "opencode/profiles/p1/data/x/cache/keep",
      "apps/data/app1/auth.json",
      "codex-home/sessions/2026/11/16/rollout.jsonl",
    ];
    expect(kept.filter((rel) => memberSpaceExcluded(rel))).toEqual([]);
  });
});

describe("the office's regenerable paths", () => {
  const root = mkdtempSync(join(tmpdir(), "regenerable-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("are the literal paths under the folders that exist, as before", () => {
    for (const dir of [
      "opencode/profiles/p1",
      "opencode/profiles/p2",
      "provider-homes/u1",
    ])
      mkdirSync(join(root, dir), { recursive: true });
    const remade = [
      "cache",
      "tmp",
      "home/.npm",
      "config/opencode/node_modules",
    ];
    expect(regenerableBackupPaths(root).sort()).toEqual(
      [
        "bin/isomux-codex-safety-hook",
        "bin/.isomux-codex-safety-hook.golden",
        "codex-home/cache",
        "codex-home/.tmp",
        "codex-home/tmp",
        ...["p1", "p2"].flatMap((p) =>
          remade.map((name) => `opencode/profiles/${p}/${name}`),
        ),
        "provider-homes/u1/codex/cache",
        "provider-homes/u1/codex/.tmp",
        "provider-homes/u1/codex/tmp",
      ].sort(),
    );
  });
});
