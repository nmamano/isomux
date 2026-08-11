// Create the project, prove what it is, and take ONE zero-secret preview
// deployment as a measurement.
//
//   bun control-plane/deploy/vercel-preview.ts
//
// Approved by Reviewer2 as exactly four steps and one preview. NOTHING here
// writes an environment variable, attaches a domain, deploys to production or
// touches git integration - and the first deploy carries no secrets at all,
// which is the point: the pages are `force-dynamic` and `/signin` reads no
// store data, so the monorepo posture can be measured with nothing sensitive
// on the platform. If the posture turns out wrong, there is nothing there to
// have leaked.
//
// THE LANDING PAGE IS THE HAZARD. The repository root is linked to `isomux`,
// so every step here proves identity before it acts: scope equality against
// that project, then id + scope + name on every later call, then a link file
// this program writes itself rather than letting `vercel link` choose from a
// list where the landing page is one of the options.
//
// WHAT IT PRINTS: booleans, small integers, and values matched against fixed
// shapes. No ids, no URLs, no build logs, no child bytes - on success and on
// every error path.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLI_WORKING_DIR,
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  inspectLink,
  vercelApi,
  vercelApiText,
} from "./vercel-api.ts";
import { inspectTokenFile, tokenFileUsable } from "./vercel-capability.ts";

/** The root directory the project is created with. A constant: this is the
 * whole subject of the measurement. */
export const ROOT_DIRECTORY = "control-plane/web";

/** The CLI version, pinned. An unpinned `@latest` would mean the thing that
 * ran is not the thing the gate approved. */
export const CLI_SPEC = "vercel@58.9.1";

interface ProjectRecord {
  id?: unknown;
  name?: unknown;
  accountId?: unknown;
  framework?: unknown;
  rootDirectory?: unknown;
  sourceFilesOutsideRootDirectory?: unknown;
  installCommand?: unknown;
  buildCommand?: unknown;
  outputDirectory?: unknown;
}

export interface SettingsVerdict {
  rootDirectoryExact: boolean;
  sourceFilesOutsideRoot: boolean;
  frameworkNextjs: boolean;
  installCommandUnset: boolean;
  buildCommandUnset: boolean;
  outputDirectoryUnset: boolean;
}

/**
 * What the project must BE, read back from the API rather than assumed from
 * what we sent.
 *
 * The three "unset" checks are not decoration: a command we did not set is a
 * command framework detection gets to choose, and the whole install/build
 * resolution question is only answerable if nothing overrode it. Null and
 * absent both count as unset; an empty string does not, because an empty
 * command is a command.
 */
export function judgeSettings(project: ProjectRecord): SettingsVerdict {
  const unset = (v: unknown) => v === null || v === undefined;
  return {
    rootDirectoryExact: project.rootDirectory === ROOT_DIRECTORY,
    sourceFilesOutsideRoot: project.sourceFilesOutsideRootDirectory === true,
    frameworkNextjs: project.framework === "nextjs",
    installCommandUnset: unset(project.installCommand),
    buildCommandUnset: unset(project.buildCommand),
    outputDirectoryUnset: unset(project.outputDirectory),
  };
}

export function settingsAllHold(verdict: SettingsVerdict): boolean {
  return Object.values(verdict).every((v) => v === true);
}

/**
 * The invariants that must hold ONCE THE INSTALL COMMAND IS SET.
 *
 * `installCommandUnset` was right while framework detection had to choose the
 * install for us - that was the only way to measure what it would choose. It is
 * deliberately false afterwards, because the measurement produced a command we
 * now set on purpose. Keeping it in the conjunction made a correct project look
 * wrong, which is what this function exists to stop; the field is still
 * REPORTED, because "the command is set" is worth seeing.
 */
export function settingsHoldWithInstallCommand(
  verdict: SettingsVerdict,
): boolean {
  return (
    verdict.rootDirectoryExact &&
    verdict.sourceFilesOutsideRoot &&
    verdict.frameworkNextjs &&
    verdict.buildCommandUnset &&
    verdict.outputDirectoryUnset
  );
}

/** A byte or file count out of a child's output, or nothing. Only a match of
 * this exact shape leaves; the child's bytes never do. */
export function uploadSizeFrom(output: string): string {
  const match = /\[[^\]]*\]\s*\(([0-9.]+\s?[KMG]?B)\)/.exec(output);
  if (match) return match[1].replace(/\s+/g, "");
  const bare = /Uploading[^\n]*?([0-9.]+\s?[KMG]?B)/.exec(output);
  return bare ? bare[1].replace(/\s+/g, "") : "unreadable";
}

export interface BuildEvidence {
  frameworkDetectedNextjs: boolean;
  /** BOTH frozen installs, not one. The final artifact installs an ancestor
   * manifest at the root and the web package's own beneath it, so a boolean
   * about "the nested lockfile" describes half the shape and reads as a
   * failure when the whole of it worked. */
  bothFrozenInstallsObserved: boolean;
  webBuildScript: boolean;
  importsOutsideRootResolved: boolean;
  landingBuildCommandAbsent: boolean;
  nextOutputProduced: boolean;
}

/**
 * The build log, turned into booleans and then forgotten.
 *
 * Each question is asked as a pattern over the log rather than by trusting the
 * settings we sent, because the settings say what was REQUESTED and the log
 * says what the builder DID. `importsOutsideRootResolved` is deliberately a
 * conjunction: a build that never reached compilation would satisfy "no module
 * errors" while proving nothing, so it also requires the evidence of a
 * completed compile.
 */
export function judgeBuild(log: string): BuildEvidence {
  const moduleError = /Module not found|Can't resolve/i.test(log);
  const compiled =
    /Compiled successfully|Generating static pages|Route \(app\)/i.test(log);
  return {
    frameworkDetectedNextjs: /Next\.js|next build/i.test(log),
    bothFrozenInstallsObserved:
      (log.match(/--frozen-lockfile/g) ?? []).length >= 2,
    webBuildScript: /Running "build" command|next build/i.test(log),
    importsOutsideRootResolved: !moduleError && compiled,
    // The landing page's build command is unmistakable: it builds the demo
    // bundle and the docs into `site`. None of it belongs in this build.
    landingBuildCommandAbsent:
      !/demo-entry|build:docs|outputDirectory[^\n]*site/i.test(log),
    nextOutputProduced: /Route \(app\)|\(Static\)|\(Dynamic\)/i.test(log),
  };
}

export function buildEvidenceAllHold(evidence: BuildEvidence): boolean {
  return Object.values(evidence).every((v) => v === true);
}

/**
 * Is this deployment row THIS run's deployment?
 *
 * Both halves matter. The project id stops another project's deployment being
 * read as ours, and the timestamp stops the previous deployment of the same
 * project being read as this one - a latest-row race that would report a stale
 * success with total confidence.
 */
export function deploymentIsOurs(
  row: { projectId?: unknown; createdAt?: unknown },
  projectId: string,
  startedAtMs: number,
): boolean {
  const created = typeof row.createdAt === "number" ? row.createdAt : 0;
  return row.projectId === projectId && created >= startedAtMs;
}

/**
 * Spawn IN A DIRECTORY, with the child's bytes captured and never forwarded.
 *
 * `fly-cli.ts`'s `realSpawn` is the same contract without a working directory,
 * and a working directory is not optional here: the repository root is linked
 * to the landing page, so a child that starts in the wrong directory is the
 * one failure this whole file is built to prevent. Setting `PWD` does not do
 * it - a process's working directory is not an environment variable.
 */
export async function spawnIn(
  cwd: string,
  argv: string[],
  env: Record<string, string>,
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    // STDIN, never argv: the process table is readable by every user on this
    // box, and a value passed as an argument is a value published to them.
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

/** Terminal states, so a poll knows when to stop. */
const TERMINAL = ["READY", "ERROR", "CANCELED"] as const;
const STATE_SHAPE = /^[A-Z_]+$/;

function shapedState(value: unknown): string {
  return typeof value === "string" && STATE_SHAPE.test(value)
    ? value
    : "unexpected";
}

async function main(): Promise<void> {
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }

  // ---------------------------------------------------------------- step 1
  const listed = await vercelApi<{ projects?: ProjectRecord[] }>(
    "/v9/projects?limit=100",
    token,
  );
  const all = listed.projects ?? [];
  const landing = all.find((p) => p.name === FORBIDDEN_PROJECT_NAMES[0]);
  if (!landing || typeof landing.accountId !== "string") {
    console.log("refusing: the landing project's scope could not be read");
    process.exitCode = 2;
    return;
  }
  if (all.some((p) => p.name === PROJECT_NAME)) {
    // Idempotence, and a refusal rather than an adoption: a project that
    // already carries this name is not provably one this program made.
    console.log("refusing: a project with our name already exists");
    process.exitCode = 2;
    return;
  }

  const created = await vercelApi<ProjectRecord>("/v9/projects", token, {
    method: "POST",
    body: {
      name: PROJECT_NAME,
      framework: "nextjs",
      rootDirectory: ROOT_DIRECTORY,
    },
  });
  const projectId = typeof created.id === "string" ? created.id : "";
  const accountId =
    typeof created.accountId === "string" ? created.accountId : "";
  console.log(`project_created: ${projectId.length > 0}`);
  console.log(`project_name_exact: ${created.name === PROJECT_NAME}`);
  console.log(`scope_equal_to_landing: ${accountId === landing.accountId}`);
  if (
    projectId.length === 0 ||
    created.name !== PROJECT_NAME ||
    accountId !== landing.accountId
  ) {
    console.log("stopping: identity or scope was not proved; re-gate");
    process.exitCode = 1;
    return;
  }
  const landingId = typeof landing.id === "string" ? landing.id : "";

  // ---------------------------------------------------------------- step 2
  await vercelApi<ProjectRecord>(`/v9/projects/${projectId}`, token, {
    method: "PATCH",
    body: { sourceFilesOutsideRootDirectory: true },
  });
  const readBack = await vercelApi<ProjectRecord>(
    `/v9/projects/${projectId}`,
    token,
  );
  const settings = judgeSettings(readBack);
  for (const [key, value] of Object.entries(settings)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`settings_all_hold: ${settingsAllHold(settings)}`);
  if (!settingsAllHold(settings) || readBack.id !== projectId) {
    console.log("stopping: the project is not what was asked for; re-gate");
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------- step 3
  const linkDir = path.join(process.cwd(), CLI_WORKING_DIR, ".vercel");
  fs.mkdirSync(linkDir, { recursive: true });
  fs.writeFileSync(
    path.join(linkDir, "project.json"),
    `${JSON.stringify({ projectId, orgId: accountId, projectName: PROJECT_NAME }, null, 2)}\n`,
  );
  const link = inspectLink(
    path.join(process.cwd(), CLI_WORKING_DIR),
    { projectId, orgId: accountId },
    landingId,
  );
  console.log(`link_present: ${link.present}`);
  console.log(`link_matches: ${link.matches}`);
  console.log(`link_forbidden: ${link.forbidden}`);
  if (!link.matches || link.forbidden) {
    console.log("stopping: the nested link does not name our project; re-gate");
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------- step 4
  const startedAtMs = Date.now();
  const spawned = await spawnIn(
    path.join(process.cwd(), CLI_WORKING_DIR),
    ["bun", "x", CLI_SPEC, "deploy", "--yes"],
    { VERCEL_TOKEN: token },
  );
  console.log(`deploy_spawned: true`);
  console.log(`cli_exit: ${spawned.code}`);
  // A NUMBER out of the child's output, and only if it matches the shape. The
  // totals are known to the CLI only as the upload completes, so this is
  // POST-upload knowledge and no preventative abort is claimed.
  console.log(
    `upload_size_reported: ${uploadSizeFrom(`${spawned.stdout}\n${spawned.stderr}`)}`,
  );
  console.log(`upload_total_known_before_completion: false`);

  const deployments = await vercelApi<{
    deployments?: { uid?: unknown; projectId?: unknown; createdAt?: unknown }[];
  }>(`/v6/deployments?projectId=${projectId}&limit=1`, token);
  const row = deployments.deployments?.[0];
  const ours = row ? deploymentIsOurs(row, projectId, startedAtMs) : false;
  console.log(`deployment_found: ${row !== undefined}`);
  console.log(`deployment_is_this_run: ${ours}`);
  if (!row || !ours || typeof row.uid !== "string") {
    console.log("stopping: no deployment provably from this invocation");
    process.exitCode = 1;
    return;
  }

  let state = "unexpected";
  for (let i = 0; i < 120; i++) {
    const detail = await vercelApi<{ readyState?: unknown }>(
      `/v13/deployments/${row.uid}`,
      token,
    );
    state = shapedState(detail.readyState);
    if ((TERMINAL as readonly string[]).includes(state)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`deployment_state: ${state}`);

  const log = await vercelApiText(
    `/v2/deployments/${row.uid}/events?builds=1&limit=1000`,
    token,
  ).catch(() => "");
  console.log(`build_log_readable: ${log.length > 0}`);
  const evidence = judgeBuild(log);
  for (const [key, value] of Object.entries(evidence)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`build_evidence_all_hold: ${buildEvidenceAllHold(evidence)}`);
  process.exitCode =
    state === "READY" && buildEvidenceAllHold(evidence) ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
