// The Preview phase, as ONE process, because the secret cannot outlive it.
//
//   bun control-plane/deploy/preview-phase.ts
//
// A `sensitive` value cannot be read back from Vercel - that is the point of
// it - so the only process that can ever mint a session cookie for this
// deployment is the one that generated the secret. Splitting "write the env"
// and "prove the deployment serves an authenticated page" into two runs would
// mean the second one could never do its job. So the ten steps below are one
// atomic phase: prove the branch, seed the fixture, generate, write, verify,
// deploy, probe, re-prove, and exit.
//
// PRODUCTION IS NOT TOUCHED. It is read twice - before and after - only to show
// it is still schema-ready and carries no user data.
//
// The artifact and install shape are the ones already proved
// (`artifact.ts`, and the fourth preview); this program orchestrates them
// rather than re-deciding them. The orchestration is deliberately similar to
// `vercel-archive-deploy.ts`; consolidating the two is a tidy-up for whoever
// merges, and duplicating fifty lines of sequencing was the lesser risk against
// editing a path that is already proved.
//
// WHAT IT PRINTS: booleans, counts, statuses, and names. No value, no id, no
// URL, no build log, no child bytes that did not match a fixed shape.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FORBIDDEN_ENV_NAMES,
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
} from "./vercel-preview.ts";
import {
  INSTALL_COMMAND,
  repositoryDigests,
  repositoryUnchanged,
  transformArtifact,
  transformIsExact,
} from "./artifact.ts";
import { createEnv, inventory, judgeInventory } from "./vercel-env.ts";
import type { EnvWrite } from "./vercel-env.ts";
import {
  PRODUCTION_BRANCH,
  SUITES_BRANCH,
  branchNamed,
  branches,
  project as neonProject,
  targetFor,
} from "../exercises/neon-api.ts";
import { Store } from "../store.ts";

const TERMINAL = ["READY", "ERROR", "CANCELED"] as const;
const STATE_SHAPE = /^[A-Z_]+$/;
/** Every line the child may contribute, and nothing else reaches a report. */
const CHILD_LINE = /^[a-z_]+: (true|false|-?\d+)$/;

/** The tables a customer's rows would land in. Production must show zero. */
const USER_TABLES = [
  "accounts",
  "name_reservations",
  "instances",
  "operations",
] as const;

async function rowCounts(store: Store): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of USER_TABLES) {
    const row = await store.sqlGet<{ n: number }>(
      `select count(*)::int as n from ${table}`,
    );
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }
  const digests = repositoryDigests(workspace);

  // ------------------------------------- re-prove the project before mutating
  const listed = await vercelApi<{
    projects?: { id?: unknown; name?: unknown; accountId?: unknown }[];
  }>("/v9/projects?limit=100", token);
  const rows = listed.projects ?? [];
  const found = rows.find((p) => p.name === PROJECT_NAME);
  const landing = rows.find((p) => p.name === FORBIDDEN_PROJECT_NAMES[0]);
  if (
    !found ||
    typeof found.id !== "string" ||
    typeof found.accountId !== "string" ||
    !landing ||
    typeof landing.accountId !== "string"
  ) {
    console.log("refusing: the project or its scope could not be read");
    process.exitCode = 2;
    return;
  }
  const projectId = found.id;
  const accountId = found.accountId;
  const settled = await vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}`,
    token,
  );
  const settings = judgeSettings(settled);
  console.log(`project_is_the_proved_one: ${found.name === PROJECT_NAME}`);
  console.log(`scope_equal_to_landing: ${accountId === landing.accountId}`);
  console.log(
    `install_command_exact: ${settled.installCommand === INSTALL_COMMAND}`,
  );
  console.log(
    `settings_hold_with_install_command: ${settingsHoldWithInstallCommand(settings)}`,
  );
  const before = await inventory(projectId, token);
  console.log(`env_count_before: ${before.length}`);
  if (
    accountId !== landing.accountId ||
    settled.installCommand !== INSTALL_COMMAND ||
    !settingsHoldWithInstallCommand(settings) ||
    before.length !== 0
  ) {
    console.log("stopping: the project is not in the state that was approved");
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------- 1. the suites branch
  const { id: neonProjectId } = await neonProject();
  const suites = await branchNamed(neonProjectId, SUITES_BRANCH);
  console.log(`suites_is_non_default: ${!suites.isDefault}`);
  console.log(`suites_has_parent: ${suites.hasParent}`);
  const all = await branches(neonProjectId);
  const defaults = all.filter((b) => b.isDefault && !b.hasParent);
  const productionOk =
    defaults.length === 1 && defaults[0].name === PRODUCTION_BRANCH;
  console.log(`production_is_the_one_default: ${productionOk}`);
  if (suites.isDefault || !suites.hasParent || !productionOk) {
    console.log("stopping: the branches are not what was approved");
    process.exitCode = 1;
    return;
  }
  const previewTarget = await targetFor(SUITES_BRANCH);
  console.log(`suites_host_from_api: ${previewTarget.hostFromApi}`);
  console.log(
    `suites_branch_id_matches: ${previewTarget.branch.id === suites.id}`,
  );

  // Store.open RETURNING is the governed-bounds proof for this exact target.
  const previewStore = await Store.open(previewTarget.dsn);
  console.log(`preview_bounds_governed: true`);

  // --------------------------- 8a. production, before anything is written
  const productionTarget = await targetFor(PRODUCTION_BRANCH);
  const productionStore = await Store.open(productionTarget.dsn);
  const productionBefore = await rowCounts(productionStore);
  console.log(`production_bounds_governed: true`);
  for (const [table, n] of Object.entries(productionBefore)) {
    console.log(`  production_before_${table}: ${n}`);
  }

  let previewSecret = crypto.randomBytes(32).toString("base64");
  console.log(`preview_secret_bytes: 32`);
  console.log(`preview_secret_encoding: base64`);
  console.log(`preview_secret_length: ${previewSecret.length}`);

  try {
    // ------------------------------------- 2. seed ONLY suites, and count
    const suitesBefore = await rowCounts(previewStore);
    const { PLANS, accountForDevSignIn, hostnameFor, reserveOffice } =
      await import("../signup.ts");
    const stamp = Math.floor(Date.now() / 1000).toString(36);
    const owner = await accountForDevSignIn(
      previewStore,
      `d3-preview-owner-${stamp}@example.com`,
    );
    const stranger = await accountForDevSignIn(
      previewStore,
      `d3-preview-stranger-${stamp}@example.com`,
    );
    const officeName = `d3prev${stamp}`;
    const reserved = await reserveOffice(previewStore, {
      accountId: owner.id,
      officeName,
      plan: PLANS[0].id,
      couponId: null,
    });
    console.log(`suites_fixture_reserved: ${reserved.ok}`);
    if (!reserved.ok) {
      console.log("stopping: the suites fixture could not be created");
      process.exitCode = 1;
      return;
    }
    const instanceId = reserved.reservation.instance_id;
    const hostname = hostnameFor(officeName);

    // ------------------------------------------ 3-4. generate, then write
    const writes: EnvWrite[] = [
      {
        key: "CONTROL_PLANE_DB",
        value: previewTarget.dsn,
        type: "sensitive",
        target: ["preview"],
      },
      {
        key: "AUTH_SECRET",
        value: previewSecret,
        type: "sensitive",
        target: ["preview"],
      },
    ];
    let writeFailed = false;
    for (const write of writes) {
      const fact = await createEnv(projectId, token, write).catch(() => null);
      const ok =
        fact !== null &&
        fact.key === write.key &&
        fact.type === "sensitive" &&
        fact.target.join(",") === "preview";
      console.log(`env_written: ${write.key} ${ok}`);
      if (!ok) writeFailed = true;
    }
    if (writeFailed) {
      // No DELETE, no PATCH, no retry: a partial write is reported and left
      // alone, and correcting it needs its own ruling.
      console.log("stopping: an env write did not come back sensitive+preview");
      process.exitCode = 1;
      return;
    }

    // ----------------------------------------------------- 5. inventory
    const facts = await inventory(projectId, token);
    const verdict = judgeInventory(facts, writes, FORBIDDEN_ENV_NAMES);
    for (const fact of facts) {
      console.log(`  env: ${fact.key} ${fact.type} ${fact.target.join("+")}`);
    }
    console.log(`inventory_exact: ${verdict.exact}`);
    console.log(`inventory_missing: ${verdict.missing.length}`);
    console.log(`inventory_unexpected: ${verdict.unexpected.length}`);
    console.log(`inventory_wrong_type: ${verdict.wrongType.length}`);
    console.log(`inventory_wrong_target: ${verdict.wrongTarget.length}`);
    console.log(
      `inventory_forbidden_present: ${verdict.forbiddenPresent.length}`,
    );
    if (!verdict.exact || verdict.forbiddenPresent.length > 0) {
      console.log("stopping: the inventory is not exactly what was approved");
      process.exitCode = 1;
      return;
    }

    // ------------------------------------------- 6. one preview deployment
    const head = new TextDecoder()
      .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout)
      .trim();
    console.log(`source_commit: ${head}`);
    const created = fs.mkdtempSync(path.join(os.tmpdir(), "d3-preview-"));
    const tarball = path.join(os.tmpdir(), `${path.basename(created)}.tar`);
    let baseUrl = "";
    try {
      Bun.spawnSync(["git", "archive", "-o", tarball, head]);
      Bun.spawnSync(["tar", "-xf", tarball, "-C", created]);
      fs.rmSync(tarball, { force: true });
      const transform = transformArtifact(created, workspace);
      console.log(`transform_is_exact: ${transformIsExact(transform)}`);
      if (!transformIsExact(transform)) {
        console.log("stopping: the artifact is not the approved one");
        process.exitCode = 1;
        return;
      }

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

      const deployments = await vercelApi<{
        deployments?: {
          uid?: unknown;
          url?: unknown;
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
      if (typeof row.url === "string" && row.url.length > 0) {
        baseUrl = `https://${row.url}`;
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
      const evidence = judgeBuild(log);
      console.log(`build_evidence_all_hold: ${buildEvidenceAllHold(evidence)}`);
      if (state !== "READY") {
        console.log("stopping: the preview did not reach READY");
        process.exitCode = 1;
        return;
      }
    } finally {
      if (created.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)) {
        fs.rmSync(created, { recursive: true, force: true });
        fs.rmSync(tarball, { force: true });
      }
      console.log(`temp_directory_removed: ${!fs.existsSync(created)}`);
    }

    // ------------------------------------------------------- 7. the probes
    console.log(`deployment_url_known: ${baseUrl.length > 0}`);
    if (baseUrl.length === 0) {
      console.log("stopping: the deployment named no host to probe");
      process.exitCode = 1;
      return;
    }
    const probe = await spawnIn(
      path.join(workspace, "control-plane", "web"),
      [
        "bun",
        path.join(workspace, "control-plane", "web", "e2e", "preview-probe.ts"),
      ],
      {},
      JSON.stringify({
        baseUrl,
        secret: previewSecret,
        ownerAccountId: owner.id,
        ownerEmail: owner.email,
        strangerAccountId: stranger.id,
        strangerEmail: stranger.email,
        instanceId,
        officeName,
        hostname,
      }),
    );
    console.log(`probe_exit: ${probe.code}`);
    // Only lines matching the fixed shape survive. The child is ours, and it
    // still does not get to widen what this program may print.
    for (const line of probe.stdout.split("\n")) {
      if (CHILD_LINE.test(line.trim())) console.log(`  ${line.trim()}`);
    }

    // -------------------------------- 8b. suites expected, production clean
    const suitesAfter = await rowCounts(previewStore);
    for (const table of USER_TABLES) {
      console.log(
        `  suites_delta_${table}: ${suitesAfter[table] - suitesBefore[table]}`,
      );
    }
    const productionAfter = await rowCounts(productionStore);
    let productionUnchanged = true;
    for (const table of USER_TABLES) {
      if (productionAfter[table] !== productionBefore[table]) {
        productionUnchanged = false;
      }
      console.log(`  production_after_${table}: ${productionAfter[table]}`);
    }
    console.log(`production_unchanged: ${productionUnchanged}`);
    console.log(
      `production_zero_user_data: ${Object.values(productionAfter).every((n) => n === 0)}`,
    );
    if (!productionUnchanged) process.exitCode = 1;
  } finally {
    // 9. Best effort: drop our reference. The value's real lifetime is this
    // process, and this is the last moment it is ours.
    previewSecret = "";
    await previewStore.close().catch(() => {});
    await productionStore.close().catch(() => {});
    console.log(
      `repository_unchanged_after_run: ${repositoryUnchanged(workspace, digests)}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
