// The project's install setting, and ONE zero-secret preview from a throwaway
// copy of the committed tree.
//
//   bun control-plane/deploy/vercel-archive-deploy.ts
//
// Four measurements got us here, and each one is now a property this program
// proves rather than a step it hopes for:
//
//   - the CLI must run where the repository root is, or Vercel applies the
//     Root Directory to whatever directory it was started in;
//   - the repository root is the landing page's, by its `.vercel` link and by
//     its `vercel.json`, so the artifact is a `git archive` copy with that one
//     file removed;
//   - dependencies must exist at the artifact root, because `control-plane/`
//     sits above the Root Directory and resolution walks UP;
//   - and the type declarations must be there too, for the same reason.
//
// The whole shape was run to a green `next build` on this box before any of it
// was pointed at Vercel. The transformation, its proof and the install command
// live in `artifact.ts`, so the local exercise and this program cannot drift.
//
// WHAT IT PRINTS: booleans, counts, and values matched against fixed shapes.
// No ids, no URLs, no build logs, no child bytes, on any path.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  vercelApi,
  vercelApiText,
} from "./vercel-api.ts";
import { inspectTokenFile, tokenFileUsable } from "./vercel-capability.ts";
import {
  CLI_SPEC,
  buildEvidenceAllHold,
  deploymentIsOurs,
  judgeBuild,
  judgeSettings,
  settingsHoldWithInstallCommand,
  spawnIn,
  uploadSizeFrom,
} from "./vercel-preview.ts";
import {
  anyClassified,
  classify,
  configEvidence,
  moduleEvidence,
} from "./vercel-diagnose.ts";
import {
  INSTALL_COMMAND,
  hasEntryNamed,
  listFiles,
  repositoryDigests,
  repositoryUnchanged,
  transformArtifact,
  transformIsExact,
} from "./artifact.ts";

/** Runtime files the build must find, relative to the artifact root. */
export const REQUIRED_IN_ARTIFACT = [
  "control-plane/web/package.json",
  "control-plane/web/bun.lock",
  "control-plane/web/next.config.ts",
  "control-plane/store.ts",
  "control-plane/signup.ts",
  "control-plane/progress.ts",
  "control-plane/ops.ts",
  "control-plane/requests.ts",
  "control-plane/mint-client.ts",
] as const;

/** The order of magnitude already measured: 1,409 tracked files, 14.3 MB. */
const FILES_RANGE = [800, 4000] as const;
const BYTES_RANGE = [4 * 1024 * 1024, 60 * 1024 * 1024] as const;

export interface ArchiveVerdict {
  noVercelLinkAnywhere: boolean;
  requiredPathsPresent: boolean;
  fileCountInRange: boolean;
  byteCountInRange: boolean;
  files: number;
  bytes: number;
}

export function judgeArchive(dir: string): ArchiveVerdict {
  const files = listFiles(dir);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += fs.statSync(path.join(dir, rel)).size;
    } catch {
      // Gone under us; not worth a message.
    }
  }
  return {
    noVercelLinkAnywhere: !hasEntryNamed(dir, ".vercel"),
    requiredPathsPresent: REQUIRED_IN_ARTIFACT.every((p) =>
      fs.existsSync(path.join(dir, p)),
    ),
    fileCountInRange:
      files.length >= FILES_RANGE[0] && files.length <= FILES_RANGE[1],
    byteCountInRange: bytes >= BYTES_RANGE[0] && bytes <= BYTES_RANGE[1],
    files: files.length,
    bytes,
  };
}

export function archiveAllHold(verdict: ArchiveVerdict): boolean {
  return (
    verdict.noVercelLinkAnywhere &&
    verdict.requiredPathsPresent &&
    verdict.fileCountInRange &&
    verdict.byteCountInRange
  );
}

/**
 * May this path be removed?
 *
 * `rm -rf` on a path a program computed is how a workspace disappears. Yes only
 * for the exact absolute directory THIS run created under the system temp
 * directory - not a parent, not the repository, not a root, and not an empty
 * string that would make the call mean something else somewhere else.
 */
export function removable(
  candidate: string,
  created: string,
  workspace: string,
): boolean {
  if (candidate.length === 0 || created.length === 0) return false;
  if (candidate !== created) return false;
  if (!path.isAbsolute(candidate)) return false;
  if (candidate === "/" || candidate === path.parse(candidate).root) {
    return false;
  }
  const tmp = fs.realpathSync(os.tmpdir());
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  if (!real.startsWith(`${tmp}${path.sep}`)) return false;
  const work = fs.realpathSync(workspace);
  return real !== work && !real.startsWith(`${work}${path.sep}`);
}

import {
  classifyAgainstHead,
  headPathsFrom,
  parsePorcelain,
} from "./tree-state.ts";

/** The paths whose staleness would matter to the artifact. */
const GUARDED_PATHS = ["control-plane/web", "control-plane"];

const SHA = /^[0-9a-f]{40}$/;
const TERMINAL = ["READY", "ERROR", "CANCELED"] as const;
const STATE_SHAPE = /^[A-Z_]+$/;

async function main(): Promise<void> {
  const workspace = process.cwd();
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }
  const digests = repositoryDigests(workspace);

  // -------------------------------------------------- identity, re-proved
  const head = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout)
    .trim();
  console.log(`source_commit: ${SHA.test(head) ? head : "unreadable"}`);
  if (!SHA.test(head)) {
    process.exitCode = 2;
    return;
  }
  // Classified against what HEAD CARRIES, not against the status prefix: the
  // archive is `git archive HEAD`, so a path HEAD does not carry cannot make it
  // stale however the index is staged. See deploy/tree-state.ts.
  const status = new TextDecoder().decode(
    Bun.spawnSync(["git", "status", "--porcelain", "--", ...GUARDED_PATHS])
      .stdout,
  );
  const tracked = new TextDecoder().decode(
    Bun.spawnSync([
      "git",
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      ...GUARDED_PATHS,
    ]).stdout,
  );
  const verdict = classifyAgainstHead(
    parsePorcelain(status),
    headPathsFrom(tracked),
  );
  const runtimeDirty = verdict.runtimeDirty;
  console.log(`runtime_paths_uncommitted_changes: ${runtimeDirty.length}`);
  console.log(`doc_only_uncommitted_changes: ${verdict.docOnly.length}`);
  console.log(`paths_not_in_head: ${verdict.notInHead.length}`);
  if (runtimeDirty.length > 0) {
    console.log("stopping: a runtime path has uncommitted changes");
    process.exitCode = 1;
    return;
  }

  const listed = await vercelApi<{
    projects?: { id?: unknown; name?: unknown; accountId?: unknown }[];
  }>("/v9/projects?limit=100", token);
  const rows = listed.projects ?? [];
  const project = rows.find((p) => p.name === PROJECT_NAME);
  const landing = rows.find((p) => p.name === FORBIDDEN_PROJECT_NAMES[0]);
  if (
    !project ||
    typeof project.id !== "string" ||
    typeof project.accountId !== "string" ||
    !landing ||
    typeof landing.accountId !== "string"
  ) {
    console.log("refusing: the project or its scope could not be read");
    process.exitCode = 2;
    return;
  }
  const projectId = project.id;
  const accountId = project.accountId;
  console.log(`project_is_the_proved_one: ${project.name === PROJECT_NAME}`);
  console.log(`scope_equal_to_landing: ${accountId === landing.accountId}`);
  if (accountId !== landing.accountId) {
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------- the one settings mutation
  //
  // IDEMPOTENT ON PURPOSE. A second identical PATCH would be a second mutation
  // to account for, and this program has already had to be run twice for
  // reasons that had nothing to do with the project's state.
  const current = await vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}`,
    token,
  );
  const alreadySet = current.installCommand === INSTALL_COMMAND;
  console.log(`install_command_already_set: ${alreadySet}`);
  if (!alreadySet) {
    await vercelApi(`/v9/projects/${projectId}`, token, {
      method: "PATCH",
      body: { installCommand: INSTALL_COMMAND },
    });
  }
  const settled = await vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}`,
    token,
  );
  const settings = judgeSettings(settled);
  const commandExact = settled.installCommand === INSTALL_COMMAND;
  console.log(`install_command_exact: ${commandExact}`);
  for (const [key, value] of Object.entries(settings)) {
    console.log(`  ${key}: ${value}`);
  }
  const hold = settingsHoldWithInstallCommand(settings);
  console.log(`settings_hold_with_install_command: ${hold}`);
  if (!commandExact || !hold || settled.id !== projectId) {
    console.log("stopping: the project is not what was asked for; re-gate");
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------- the copy
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "d3-archive-"));
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

    const transform = transformArtifact(created, workspace);
    console.log(`artifact_files_before: ${transform.filesBefore}`);
    console.log(`artifact_files_after: ${transform.filesAfter}`);
    console.log(`artifact_removed: ${transform.removed.length}`);
    for (const f of transform.removed) console.log(`  removed: ${f}`);
    console.log(`artifact_replaced: ${transform.replaced.length}`);
    for (const f of transform.replaced) console.log(`  replaced: ${f}`);
    console.log(`artifact_added: ${transform.added.length}`);
    // The pair is UNTRACKED today, so this names what it actually compared.
    console.log(
      `copies_match_vercel_pair_source: ${transform.copiesMatchSource}`,
    );
    console.log(`transform_is_exact: ${transformIsExact(transform)}`);
    console.log(
      `repository_unchanged_after_transform: ${repositoryUnchanged(workspace, digests)}`,
    );

    const verdict = judgeArchive(created);
    console.log(`archive_no_vercel_link: ${verdict.noVercelLinkAnywhere}`);
    console.log(`archive_required_paths: ${verdict.requiredPathsPresent}`);
    console.log(`archive_files: ${verdict.files}`);
    console.log(
      `archive_megabytes: ${(verdict.bytes / 1024 / 1024).toFixed(1)}`,
    );
    console.log(`archive_totals_known_before_upload: true`);
    if (!transformIsExact(transform) || !archiveAllHold(verdict)) {
      console.log("stopping: the artifact is not the one that was measured");
      process.exitCode = 1;
      return;
    }

    // ------------------------------------------------------------ the deploy
    const startedAtMs = Date.now();
    const spawned = await spawnIn(
      created,
      ["bun", "x", CLI_SPEC, "deploy", "--yes"],
      {
        VERCEL_TOKEN: token,
        VERCEL_ORG_ID: accountId,
        VERCEL_PROJECT_ID: projectId,
      },
    );
    console.log(`cli_exit: ${spawned.code}`);
    console.log(
      `upload_size_reported: ${uploadSizeFrom(`${spawned.stdout}\n${spawned.stderr}`)}`,
    );
    console.log(`upload_total_known_before_completion: false`);

    const deployments = await vercelApi<{
      deployments?: {
        uid?: unknown;
        projectId?: unknown;
        createdAt?: unknown;
      }[];
    }>(`/v6/deployments?projectId=${projectId}&limit=1`, token);
    const row = deployments.deployments?.[0];
    const ours = row ? deploymentIsOurs(row, projectId, startedAtMs) : false;
    console.log(`deployment_is_this_run: ${ours}`);
    if (!row || !ours || typeof row.uid !== "string") {
      console.log("stopping: no deployment provably from this invocation");
      process.exitCode = 1;
      return;
    }

    let state = "unexpected";
    for (let i = 0; i < 180; i++) {
      const detail = await vercelApi<{ readyState?: unknown }>(
        `/v13/deployments/${row.uid}`,
        token,
      );
      const raw = detail.readyState;
      state =
        typeof raw === "string" && STATE_SHAPE.test(raw) ? raw : "unexpected";
      if ((TERMINAL as readonly string[]).includes(state)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`deployment_state: ${state}`);

    const log = await vercelApiText(
      `/v2/deployments/${row.uid}/events?builds=1&limit=2000`,
      token,
    ).catch(() => "");
    console.log(`build_log_readable: ${log.length > 0}`);

    // --------------------------------------------- the required terminal set
    const config = configEvidence(log);
    const modules = moduleEvidence(log);
    const evidence = judgeBuild(log);
    const frozen = (log.match(/--frozen-lockfile/g) ?? []).length;
    console.log(
      `root_ancestor_frozen_install_observed: ${/cd \.\.\/\.\./.test(log) && frozen >= 1}`,
    );
    console.log(
      `nested_web_frozen_install_observed: ${config.nestedWebBuild && frozen >= 2}`,
    );
    console.log(`both_frozen_installs_observed: ${frozen >= 2}`);
    console.log(`project_root_directory_applied: ${config.nestedWebBuild}`);
    console.log(
      `root_landing_config_absent: ${!config.landingDemoBuild && !config.landingDocsBuild && !config.landingOutputDirectory}`,
    );
    console.log(
      `outside_root_imports_resolved: ${!modules.unresolvedOutsideRootImport}`,
    );
    console.log(
      `pg_unresolved: ${modules.unresolvedWebDependencies.includes("pg")}`,
    );
    console.log(`no_dependency_unresolved: ${!modules.unresolvedDependency}`);
    console.log(`next_output_produced: ${evidence.nextOutputProduced}`);
    console.log(`build_evidence_all_hold: ${buildEvidenceAllHold(evidence)}`);

    if (state !== "READY") {
      const classes = classify(log);
      for (const [key, value] of Object.entries(classes)) {
        if (value) console.log(`  failure_class: ${key}`);
      }
      console.log(`cause_classified: ${anyClassified(classes)}`);
      process.exitCode = 1;
    }
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
