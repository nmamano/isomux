// Attach cloud.isomux.com, derive the record a human must write, and park.
//
//   bun control-plane/deploy/attach-phase.ts
//
// ONE mutation: the attach. No DNS is written here - nothing in this repository
// holds a registrar credential - and no Production env or deployment follows in
// this phase. The rollback is pre-approved for this one constant hostname on
// this one proved project, and it fires only for a failed invariant, never for
// the ordinary pre-DNS state where the domain is attached and DNS is not yet
// pointing at it.
//
// WHAT IT PRINTS: booleans, counts, statuses, and the finished public DNS
// records. A DNS record is meant to be read; nothing else from either response
// is printed.

import { Resolver } from "node:dns/promises";
import {
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  vercelApi,
} from "./vercel-api.ts";
import { inspectTokenFile, tokenFileUsable } from "./vercel-capability.ts";
import {
  TARGET_DOMAIN,
  attach,
  attachHeld,
  detach,
  detachHeld,
  domainConfig,
  domainsOf,
  judgeDomains,
  projectDomain,
  recordSet,
  renderRecord,
} from "./vercel-domain.ts";
import {
  judgeSettings,
  settingsHoldWithInstallCommand,
} from "./vercel-preview.ts";
import { INSTALL_COMMAND } from "./artifact.ts";

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function recordCount(kind: string, name: string): Promise<number> {
  try {
    const rows = await (
      resolver as unknown as {
        resolve: (n: string, k: string) => Promise<unknown[]>;
      }
    ).resolve(name, kind);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    return code === "ENODATA" || code === "ENOTFOUND" ? 0 : -1;
  }
}

/** The public view, measured. `000` is "no HTTPS answer at all", which is what
 * an unresolvable name gives and is a reading rather than an assumption. */
async function publicState(label: string): Promise<{ clean: boolean }> {
  let total = 0;
  for (const kind of ["CNAME", "A", "AAAA", "TXT"]) {
    const n = await recordCount(kind, TARGET_DOMAIN);
    console.log(`  ${label}_${kind}_records: ${n}`);
    if (n > 0) total += n;
  }
  let status = "000";
  try {
    const res = await fetch(`https://${TARGET_DOMAIN}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    status = String(res.status);
  } catch {
    status = "000";
  }
  console.log(`  ${label}_https_status: ${status}`);
  console.log(`  ${label}_resolves: ${total > 0}`);
  return { clean: total === 0 && status === "000" };
}

async function main(): Promise<void> {
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }

  const listed = await vercelApi<{
    projects?: { id?: unknown; name?: unknown; accountId?: unknown }[];
  }>("/v9/projects?limit=100", token);
  const rows = listed.projects ?? [];
  const ours = rows.find((p) => p.name === PROJECT_NAME);
  const landing = rows.find((p) => p.name === FORBIDDEN_PROJECT_NAMES[0]);
  if (
    !ours ||
    typeof ours.id !== "string" ||
    typeof ours.accountId !== "string" ||
    !landing ||
    typeof landing.accountId !== "string"
  ) {
    console.log("refusing: the project or its scope could not be read");
    process.exitCode = 2;
    return;
  }
  const projectId = ours.id;
  const settled = await vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}`,
    token,
  );
  const settings = judgeSettings(settled);
  console.log(`project_is_the_proved_one: ${ours.name === PROJECT_NAME}`);
  console.log(
    `scope_equal_to_landing: ${ours.accountId === landing.accountId}`,
  );
  console.log(
    `install_command_exact: ${settled.installCommand === INSTALL_COMMAND}`,
  );
  console.log(
    `settings_hold_with_install_command: ${settingsHoldWithInstallCommand(settings)}`,
  );

  const beforeDomains = judgeDomains(await domainsOf(projectId, token));
  console.log(`target_already_attached: ${beforeDomains.targetPresent}`);
  console.log(
    `generated_domain_present: ${beforeDomains.autoDomainStillPresent}`,
  );
  console.log(`other_domains: ${beforeDomains.otherDomainsAdded}`);
  if (
    ours.accountId !== landing.accountId ||
    settled.installCommand !== INSTALL_COMMAND ||
    !settingsHoldWithInstallCommand(settings) ||
    beforeDomains.targetPresent ||
    !beforeDomains.autoDomainStillPresent ||
    beforeDomains.otherDomainsAdded !== 0
  ) {
    console.log("stopping: the project is not in the approved state");
    process.exitCode = 1;
    return;
  }

  // ------------------------------- the public state, re-measured before POST
  console.log("public_state_before_attach:");
  const before = await publicState("before");
  if (!before.clean) {
    console.log(
      "stopping: a public record or answer exists; report the conflict",
    );
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------- the one mutation
  await attach(projectId, token);
  console.log(`attach_issued: true`);

  const afterDomains = judgeDomains(await domainsOf(projectId, token));
  const held = attachHeld(afterDomains);
  console.log(`attach_held: ${held}`);
  console.log(`target_present: ${afterDomains.targetPresent}`);
  console.log(
    `generated_domain_unchanged: ${afterDomains.autoDomainStillPresent}`,
  );
  console.log(`other_domains_added: ${afterDomains.otherDomainsAdded}`);

  const record = await projectDomain(projectId, token).catch(() => null);
  const ownershipVerified = record?.verified === true;
  const nameExact = record?.name === TARGET_DOMAIN;
  console.log(`ownership_verified: ${ownershipVerified}`);
  console.log(`returned_name_exact: ${nameExact}`);

  const config = await domainConfig(token).catch(() => null);
  const set = config
    ? recordSet(config, config.acceptedChallenges)
    : { records: [], ok: false, conflicts: -1 };
  console.log(`config_readable: ${config !== null}`);
  console.log(`dns_configured: ${config?.misconfigured === false}`);
  console.log(`config_conflicts: ${set.conflicts}`);
  console.log(`record_set_ok: ${set.ok}`);

  if (!held || !nameExact || !set.ok) {
    // An invariant failed, so the attach is rolled back BEFORE anything else.
    console.log("rolling back: an attach or record invariant failed");
    let rolledBack = false;
    try {
      await detach(projectId, projectId, token);
      rolledBack = detachHeld(judgeDomains(await domainsOf(projectId, token)));
    } catch {
      rolledBack = false;
    }
    console.log(`detach_held: ${rolledBack}`);
    if (!rolledBack) console.log("DOMAIN ROLLBACK FAILED");
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------ the records a human must write
  console.log(`records_to_write: ${set.records.length}`);
  for (const r of set.records) console.log(`  RECORD  ${renderRecord(r)}`);

  console.log("public_state_after_attach:");
  await publicState("after");
  console.log(
    "parked: the record is for Nil to write in Namecheap; no DNS was written here",
  );
}

if (import.meta.main) {
  await main();
}
