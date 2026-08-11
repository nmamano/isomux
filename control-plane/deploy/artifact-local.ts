// Build the transformed artifact LOCALLY and prove it works, before any
// Vercel mutation.
//
//   bun control-plane/deploy/artifact-local.ts
//
// Three preview deployments have now failed, each teaching one thing, and each
// costing a round trip to find out. This program moves the loop onto this box:
// it makes the same artifact, runs the same install command from the same
// starting directory Vercel starts it in, and runs the same build - so the next
// deployment is a confirmation rather than an experiment.
//
// It touches NOTHING outside a fresh temp directory, reaches no network beyond
// the two installs, needs no database, no deployment secret and no Vercel
// credential at all.
//
// WHAT IT PRINTS: booleans, counts, exit codes, and paths that are ours by
// construction. No repository digests, no build logs, no child bytes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INSTALL_COMMAND,
  hasEntryNamed,
  repositoryDigests,
  repositoryUnchanged,
  transformArtifact,
  transformIsExact,
} from "./artifact.ts";
import { removable } from "./vercel-archive-deploy.ts";

/** Where Vercel starts the install command: the project's Root Directory. */
const ROOT_DIRECTORY = "control-plane/web";

/** The build Vercel runs once the framework is detected, under Node. */
const BUILD_ARGV = ["node", "node_modules/.bin/next", "build"];

interface Ran {
  code: number;
  out: string;
}

function run(
  cwd: string,
  argv: string[],
  env: Record<string, string> = {},
): Ran {
  const child = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode,
    out: `${new TextDecoder().decode(child.stdout)}\n${new TextDecoder().decode(child.stderr)}`,
  };
}

/**
 * Run with an environment we built, rather than the one we inherited.
 *
 * PATH and HOME only. A build that needs more than that is a build whose
 * requirements we want to discover here rather than on Vercel.
 */
function runClean(cwd: string, argv: string[]): Ran {
  const child = Bun.spawnSync(argv, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode,
    out: `${new TextDecoder().decode(child.stdout)}\n${new TextDecoder().decode(child.stderr)}`,
  };
}

function directorySize(dir: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const here = stack.pop()!;
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      entries++;
      try {
        bytes += fs.lstatSync(full).size;
      } catch {
        // Gone under us; not worth a message.
      }
    }
  }
  return { entries, bytes };
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const digests = repositoryDigests(workspace);

  const head = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout)
    .trim();
  console.log(
    `source_commit: ${/^[0-9a-f]{40}$/.test(head) ? head : "unreadable"}`,
  );

  const created = fs.mkdtempSync(path.join(os.tmpdir(), "d3-local-"));
  const tarball = path.join(os.tmpdir(), `${path.basename(created)}.tar`);
  let cleaned = false;
  try {
    const archived = Bun.spawnSync(["git", "archive", "-o", tarball, head]);
    const extracted = Bun.spawnSync(["tar", "-xf", tarball, "-C", created]);
    fs.rmSync(tarball, { force: true });
    console.log(
      `archive_ready: ${archived.exitCode === 0 && extracted.exitCode === 0}`,
    );
    if (archived.exitCode !== 0 || extracted.exitCode !== 0) {
      process.exitCode = 1;
      return;
    }
    console.log(
      `archive_no_vercel_link: ${!hasEntryNamed(created, ".vercel")}`,
    );

    // ------------------------------------------- the three transformations
    const verdict = transformArtifact(created, workspace);
    console.log(`artifact_files_before: ${verdict.filesBefore}`);
    console.log(`artifact_files_after: ${verdict.filesAfter}`);
    console.log(`artifact_removed: ${verdict.removed.length}`);
    for (const f of verdict.removed) console.log(`  removed: ${f}`);
    console.log(`artifact_replaced: ${verdict.replaced.length}`);
    for (const f of verdict.replaced) console.log(`  replaced: ${f}`);
    console.log(`artifact_added: ${verdict.added.length}`);
    console.log(`copies_match_committed_source: ${verdict.copiesMatchSource}`);
    console.log(`transform_is_exact: ${transformIsExact(verdict)}`);
    console.log(
      `repository_unchanged_after_transform: ${repositoryUnchanged(workspace, digests)}`,
    );
    if (!transformIsExact(verdict)) {
      console.log("stopping: the transformation is not the ruled one");
      process.exitCode = 1;
      return;
    }

    // ----------------------------------------------- the exact install command
    //
    // Run from the Root Directory, which is where Vercel starts it. The command
    // is the committed constant, not a paraphrase of it.
    const startDir = path.join(created, ROOT_DIRECTORY);
    console.log(`install_starts_in: ${ROOT_DIRECTORY}`);
    const install = run(startDir, ["bash", "-c", INSTALL_COMMAND]);
    console.log(`install_exit: ${install.code}`);
    console.log(
      `install_used_frozen_lockfile_twice: ${(INSTALL_COMMAND.match(/--frozen-lockfile/g) ?? []).length === 2}`,
    );
    if (install.code !== 0) {
      console.log("stopping: the install command failed");
      process.exitCode = 1;
      return;
    }

    const rootModules = path.join(created, "node_modules");
    const webModules = path.join(created, ROOT_DIRECTORY, "node_modules");
    console.log(`root_node_modules_present: ${fs.existsSync(rootModules)}`);
    console.log(`web_node_modules_present: ${fs.existsSync(webModules)}`);
    const rootTop = fs.existsSync(rootModules)
      ? fs.readdirSync(rootModules).filter((n) => !n.startsWith(".")).length
      : 0;
    const rootSize = directorySize(rootModules);
    console.log(`root_install_top_level_packages: ${rootTop}`);
    console.log(`root_install_files: ${rootSize.entries}`);
    console.log(
      `root_install_megabytes: ${(rootSize.bytes / 1024 / 1024).toFixed(1)}`,
    );

    // ------------- does `pg` resolve from an importer under control-plane/?
    //
    // The question is not "is pg installed somewhere" but "can the file that
    // imports it find it", and that file is `control-plane/store.ts`. Node
    // resolves a bare specifier by walking up from the importing directory, so
    // this asks from exactly there.
    const probeDir = path.join(created, "control-plane");
    const probe = run(probeDir, [
      "node",
      "-e",
      "process.stdout.write(require.resolve('pg'))",
    ]);
    const resolved = probe.out.trim().split("\n")[0] ?? "";
    const fromRoot = resolved.startsWith(`${rootModules}${path.sep}`);
    console.log(`pg_resolves_from_control_plane: ${probe.code === 0}`);
    console.log(`pg_resolves_to_artifact_root_node_modules: ${fromRoot}`);

    // The TYPES are a separate resolution with the same rule, and the one that
    // failed with TS7016: `next build` type-checks `../store.ts`, and
    // TypeScript looks for `@types/pg` upward from THAT file, not from the web
    // package where its own devDependency lives.
    const typesProbe = run(probeDir, [
      "node",
      "-e",
      "process.stdout.write(require.resolve('@types/pg/package.json'))",
    ]);
    const typesResolved = typesProbe.out.trim().split("\n")[0] ?? "";
    console.log(
      `pg_types_resolve_from_control_plane: ${typesProbe.code === 0}`,
    );
    console.log(
      `pg_types_resolve_to_artifact_root_node_modules: ${typesResolved.startsWith(`${rootModules}${path.sep}`)}`,
    );

    // ------------------------------------------------ the exact Next build
    //
    // A MINIMAL ENVIRONMENT, not this shell's. Two reasons, and both matter:
    // Vercel's builder does not carry an operator's variables, so inheriting
    // them would measure a build nobody will ever run; and this is the one
    // place whose output is printed, so it must not be able to carry a value
    // out of the surrounding process.
    const build = runClean(startDir, BUILD_ARGV);
    console.log(`build_exit: ${build.code}`);
    console.log(
      `build_module_not_found: ${/Module not found/i.test(build.out)}`,
    );
    console.log(
      `build_outside_root_import_unresolved: ${/Can't resolve ['"]\.\./.test(build.out)}`,
    );
    console.log(
      `build_next_output_present: ${fs.existsSync(path.join(startDir, ".next"))}`,
    );
    console.log(
      `build_route_table_printed: ${/Route \(app\)/i.test(build.out)}`,
    );
    if (build.code !== 0) {
      // The failing lines only, capped, from a build run in an environment
      // this program constructed. This is the one output that is not a
      // boolean, and it exists because three deployments have now failed for
      // three different reasons and the next one should not be a fourth guess.
      const lines = build.out
        .split("\n")
        .filter((l) => /error|failed|cannot|missing|⨯|✗/i.test(l))
        .slice(0, 12);
      console.log(`build_error_lines: ${lines.length}`);
      for (const line of lines) console.log(`  | ${line.trim().slice(0, 160)}`);
    }
    process.exitCode = build.code === 0 && probe.code === 0 && fromRoot ? 0 : 1;
  } finally {
    if (removable(created, created, workspace)) {
      fs.rmSync(created, { recursive: true, force: true });
      fs.rmSync(tarball, { force: true });
      cleaned = !fs.existsSync(created);
    }
    console.log(`temp_directory_removed: ${cleaned}`);
    console.log(
      `repository_unchanged_after_run: ${repositoryUnchanged(workspace, digests)}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
