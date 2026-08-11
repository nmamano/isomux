// Why did the one approved preview fail? Read-only, fixed vocabulary.
//
//   bun control-plane/deploy/vercel-diagnose.ts
//
// Every request is a GET, and it deploys nothing: a failure is evidence, not
// permission for a second attempt. It exists because "every build boolean came
// back false" says the build did not happen and says nothing about why, and a
// re-gate needs a cause rather than an absence.
//
// The vocabulary is FIXED and closed. Each question is a named failure class
// this deployment could plausibly have hit, answered as a boolean over the
// build log - and the log itself is judged and dropped, never printed. A cause
// nobody listed comes back as `unclassified`, which is an honest answer rather
// than a quoted stack somebody would paste into a report.

import { PROJECT_NAME, vercelApi, vercelApiText } from "./vercel-api.ts";
import { judgeBuild } from "./vercel-preview.ts";
import { inspectTokenFile, tokenFileUsable } from "./vercel-capability.ts";

export interface FailureClasses {
  rootDirectoryMissing: boolean;
  nothingUploaded: boolean;
  packageJsonMissing: boolean;
  installFailed: boolean;
  lockfileRefused: boolean;
  nextMissing: boolean;
  moduleOutsideRootUnresolved: boolean;
  outputDirectoryMissing: boolean;
  buildCommandExited: boolean;
  notAuthorized: boolean;
}

export function classify(log: string): FailureClasses {
  return {
    rootDirectoryMissing:
      /Root Directory[^\n]*(does not exist|is not|cannot be found)|specified Root Directory/i.test(
        log,
      ),
    nothingUploaded:
      /No files were uploaded|no files found|empty deployment/i.test(log),
    packageJsonMissing:
      /Could not read package\.json|package\.json[^\n]*not found|No package\.json/i.test(
        log,
      ),
    installFailed: /(install[^\n]*(failed|error))|ERR_PNPM|npm ERR!/i.test(log),
    // A REFUSAL, not the flag. `--frozen-lockfile` appears in this build's own
    // successful install command, so matching the bare flag reported a failure
    // on a deployment that reached READY.
    lockfileRefused:
      /lockfile[^\n]*(out of date|mismatch|outdated|had changes)|frozen-lockfile[^\n]*(failed|error)/i.test(
        log,
      ),
    nextMissing: /next: not found|Cannot find module 'next'/i.test(log),
    moduleOutsideRootUnresolved: /Module not found|Can't resolve/i.test(log),
    outputDirectoryMissing: /No Output Directory/i.test(log),
    buildCommandExited: /Command[^\n]*exited with|Build failed/i.test(log),
    notAuthorized: /not authorized|forbidden|401|403/i.test(log),
  };
}

/**
 * WHOSE configuration did the builder use?
 *
 * Separate from the failure classes on purpose: these say what the build WAS,
 * not what went wrong with it. The landing page's build command is
 * unmistakable - it builds a demo bundle and the docs into `site` - so its
 * presence in a control-plane build log is proof that the repository-root
 * `vercel.json` was read under a set Root Directory.
 */
export interface ConfigEvidence {
  landingDemoBuild: boolean;
  landingDocsBuild: boolean;
  landingOutputDirectory: boolean;
  vercelJsonMentioned: boolean;
  nestedWebBuild: boolean;
}

export function configEvidence(log: string): ConfigEvidence {
  return {
    landingDemoBuild: /demo-entry/i.test(log),
    landingDocsBuild: /build:docs/i.test(log),
    landingOutputDirectory: /site\/demo|outputDirectory[^\n]*site/i.test(log),
    vercelJsonMentioned: /vercel\.json/i.test(log),
    nestedWebBuild: /control-plane\/web/i.test(log),
  };
}

/**
 * WHICH module could not be resolved?
 *
 * "Module not found" has two completely different causes here and they lead to
 * opposite fixes: a `../../` import means the sources outside the root
 * directory did not reach the build, and a bare package name means the install
 * did not put dependencies where the build looks. A closed vocabulary, so an
 * unlisted specifier is reported as neither rather than guessed at.
 */
export interface ModuleEvidence {
  unresolvedOutsideRootImport: boolean;
  unresolvedDependency: boolean;
  installRan: boolean;
  installUsedFrozenLockfile: boolean;
  /** Which of the web package's OWN dependencies went missing. A closed list:
   * an unlisted name is reported by none of these rather than guessed at. */
  unresolvedWebDependencies: string[];
}

/** The web package's dependencies, by name. Nothing else may be reported. */
export const WEB_DEPENDENCIES = [
  "next",
  "next-auth",
  "pg",
  "react",
  "react-dom",
] as const;

export function moduleEvidence(log: string): ModuleEvidence {
  const unresolved = /Can't resolve ['"]([^'"]+)['"]/g;
  let outside = false;
  let dependency = false;
  for (const hit of log.matchAll(unresolved)) {
    const specifier = hit[1];
    if (specifier.startsWith(".")) outside = true;
    else dependency = true;
  }
  return {
    unresolvedOutsideRootImport: outside,
    unresolvedDependency: dependency,
    installRan: /Running "install" command|bun install|npm install/i.test(log),
    installUsedFrozenLockfile: /--frozen-lockfile/i.test(log),
    unresolvedWebDependencies: WEB_DEPENDENCIES.filter((name) =>
      new RegExp(`Can't resolve ['"]${name}(/[^'"]*)?['"]`).test(log),
    ),
  };
}

export function anyClassified(classes: FailureClasses): boolean {
  return Object.values(classes).some((v) => v === true);
}

async function main(): Promise<void> {
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }

  const listed = await vercelApi<{
    projects?: { id?: unknown; name?: unknown }[];
  }>("/v9/projects?limit=100", token);
  const project = (listed.projects ?? []).find((p) => p.name === PROJECT_NAME);
  if (!project || typeof project.id !== "string") {
    console.log("refusing: our project was not found");
    process.exitCode = 2;
    return;
  }

  const deployments = await vercelApi<{ deployments?: { uid?: unknown }[] }>(
    `/v6/deployments?projectId=${project.id}&limit=1`,
    token,
  );
  const uid = deployments.deployments?.[0]?.uid;
  if (typeof uid !== "string") {
    console.log("refusing: no deployment to read");
    process.exitCode = 2;
    return;
  }

  const log = await vercelApiText(
    `/v2/deployments/${uid}/events?builds=1&limit=1000`,
    token,
  ).catch(() => "");
  console.log(`build_log_readable: ${log.length > 0}`);
  console.log(`build_log_lines: ${log.split("\n").length}`);

  const classes = classify(log);
  for (const [key, value] of Object.entries(classes)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`cause_classified: ${anyClassified(classes)}`);
  if (!anyClassified(classes)) console.log("cause: unclassified");

  const config = configEvidence(log);
  for (const [key, value] of Object.entries(config)) {
    console.log(`  config_${key}: ${value}`);
  }

  const build = judgeBuild(log);
  for (const [key, value] of Object.entries(build)) {
    console.log(`  build_${key}: ${value}`);
  }

  const modules = moduleEvidence(log);
  console.log(
    `  module_unresolvedOutsideRootImport: ${modules.unresolvedOutsideRootImport}`,
  );
  console.log(`  module_unresolvedDependency: ${modules.unresolvedDependency}`);
  console.log(`  module_installRan: ${modules.installRan}`);
  console.log(
    `  module_installUsedFrozenLockfile: ${modules.installUsedFrozenLockfile}`,
  );
  console.log(
    `  module_unresolvedWebDependencies: ${modules.unresolvedWebDependencies.length}`,
  );
  for (const name of modules.unresolvedWebDependencies) {
    console.log(`    unresolved: ${name}`);
  }
}

if (import.meta.main) {
  await main();
}
