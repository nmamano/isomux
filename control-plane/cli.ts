#!/usr/bin/env bun
// The one command, and the pieces it is built from.
//
//   list      read the provider account. ALWAYS the first thing done, and the
//             only safe way to answer "do we already have a box?"
//   recycle   rebuild an adopted box with a fresh per-run key
//   provision first contact -> installer -> HTTPS -> invite, and with
//             --handoff-now, revocation and its proof
//   run       the tick loop as its own process
//   tick      one pass
//   ops       the operation rows; attention  the open reasons
//   status    one tick against the current generation
//   revoke    revoke, prove, destroy - for the held case and after a failure
//   expiry-test  the ruling-9 verification, both variants
//
// The chain is the same as slice 1's and the driver primitives are the same.
// What changed is that every step is now a durable, leased operation row, so
// --stop-after and --handoff-now are the instance's GOAL rather than control
// flow, and killing this process mid-flight is recoverable from the rows alone.
//
// There is deliberately NO create command here. The adapter can create a box and
// the stub tier exercises that path, but no flag in this file reaches it: the
// handler that can spend money is not even registered in this process, and the
// call itself is latched durably by create-latch.ts.

import { accessWindowDurationMs } from "./access-window-policy.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import { AuditLog } from "./audit.ts";
import { BRANCH_PIN_ENV, provePinnedBranch } from "./boot.ts";
import {
  bootstrapDatabase,
  migrateCustomerSshKeyColumns,
  migrateHostedCancellationPolicy,
  migrateMultiOfficeReservations,
  migratePendingCheckoutColumns,
  reportBootstrap,
} from "./bootstrap.ts";
import {
  AUDIT_FILE,
  databaseUrl,
  DEFAULT_LOGIN_USER,
  INTENTS_DIR,
  KEYS_DIR,
  RUNS_DIR,
  SSH_WAIT_TIMEOUT_MS,
  STATE_ROOT,
  UBUNTU_2404_IMAGE_ID,
} from "./config.ts";
import { ContaboAdapter } from "./contabo/adapter.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "./contabo/auth.ts";
import { ContaboHttp } from "./contabo/http.ts";
import {
  WRAPPER_REMOTE_PATH,
  identityFor,
  parseTick,
  onCalendarFromExpiry,
  timerIsArmed,
  waitForAuthenticatedSsh,
} from "./driver.ts";
import { destroyPrivateKey, generateKeyPair } from "./keys.ts";
import { Reporter } from "./report.ts";
import { SpawnExec, SshClient, type SshTarget } from "./ssh.ts";
import { acknowledgeAttention } from "./attention-ack.ts";
import { CreateLatch, migrateLegacyIntents } from "./create-latch.ts";
import { CreateCoordinator } from "./create-coordinator.ts";
import { IntentJournal } from "./intents.ts";
import { prepareCreateRun } from "./run-preparation.ts";
import { type HandlerDeps } from "./handlers.ts";
import {
  CeilingIsImmutable,
  ensureInstance as ensureInstanceRow,
} from "./instance.ts";
import { InviteHold } from "./invite-hold.ts";
import { watchLiveness } from "./liveness-watch.ts";
import {
  readReleaseIdentity,
  startMintSeam,
  type ReleaseIdentity,
  type RunningMintSeam,
} from "./mint-seam.ts";
import { CertificateService } from "./certificate-service.ts";
import { certificateTargetFromEnv } from "./certificate-target.ts";
import { obtainCertificateWithLego } from "./lego-acme.ts";
import { CloudflareDns } from "./cloudflare-dns.ts";
import { FIRST_KIND, type Goal, type OperationKind } from "./operations.ts";
import { PROVIDER_DEPENDENT_KINDS, tickerHandlerRoster } from "./run-roster.ts";
import { sweepProvisioningStarts } from "./provisioning-start.ts";
import { sweepCustomerKeyRetention } from "./access-retention.ts";
import { setOperator } from "./operator-admin.ts";
import { readAndRefreshMarker } from "./state-marker.ts";
import { Store } from "./store.ts";
import { PROVISIONER_POOL } from "./roles.ts";
import { IDLE_MAINTENANCE_INTERVAL_MS, Ticker } from "./tick.ts";
import { StripeClient } from "./stripe/client.ts";
import {
  resolveStripeMode,
  stripeKeyFromEnv,
  stripeWebhookSecretFromEnv,
} from "./stripe/mode.ts";
import { LiveStripeReader, type StripeObjectReader } from "./stripe/reader.ts";
import { WebhookProcessor } from "./stripe/webhook.ts";
import { pollPendingCheckouts } from "./stripe/checkout-poll.ts";
import { driveTicks } from "./drive-loop.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";

const reporter = new Reporter();
const audit = new AuditLog(AUDIT_FILE, "control-plane-cli");
const exec = new SpawnExec();

// ---------------------------------------------------------------- arguments

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      out.set(arg.slice(2), next && !next.startsWith("--") ? next : "true");
      if (next && !next.startsWith("--")) i++;
    }
  }
  return out;
}

function required(args: Map<string, string>, name: string): string {
  const v = args.get(name);
  if (!v || v === "true") die(`--${name} is required`);
  return v;
}

function die(message: string): never {
  reporter.problem(`error: ${message}`);
  process.exit(2);
}

/**
 * Parse the access window into an absolute instant.
 *
 * The window stays explicit for operator runs, but R-2026-08-15-1 makes seven
 * days an absolute maximum. A shorter diagnostic run is allowed; a longer one
 * fails before the instance row can be created.
 */
function accessWindowInstant(
  args: Map<string, string>,
  now = new Date(),
): Date {
  const raw = args.get("access-window");
  if (!raw || raw === "true") {
    die(
      "--access-window is required (e.g. 2h, 45m, 7d) and cannot exceed seven days.",
    );
  }
  try {
    return new Date(now.getTime() + accessWindowDurationMs(raw));
  } catch (err) {
    die(`--access-window ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------------ adapter

function makeAdapter(): ContaboAdapter {
  const creds = credentialsFromEnv();
  const fetchImpl = fetch as unknown as FetchLike;
  return new ContaboAdapter({
    http: new ContaboHttp({
      fetchImpl,
      tokens: new TokenProvider(creds, fetchImpl),
    }),
    imageId: UBUNTU_2404_IMAGE_ID,
    loginUser: DEFAULT_LOGIN_USER,
  });
}

// --------------------------------------------------------------- run record

import type { RunRecord } from "./run-record.ts";
import {
  loadRun as loadRunFrom,
  resumeRun,
  saveRun as saveRunTo,
} from "./run-record.ts";

function saveRun(rec: RunRecord): void {
  saveRunTo(RUNS_DIR, rec);
}

function loadRun(runId: string): RunRecord {
  const rec = loadRunFrom(RUNS_DIR, runId);
  if (!rec) return die(`no run record for ${runId} under ${RUNS_DIR}`);
  return rec;
}

function targetFor(rec: RunRecord): SshTarget {
  return {
    host: rec.ipv4,
    user: rec.loginUser,
    identityFile: rec.privateKeyPath,
    knownHostsFile: rec.knownHostsFile,
  };
}

// ------------------------------------------------------------------ helpers

async function waitForSsh(
  rec: RunRecord,
  timeoutMs = SSH_WAIT_TIMEOUT_MS,
): Promise<number> {
  let n = 0;
  const { elapsedMs } = await waitForAuthenticatedSsh({
    target: targetFor(rec),
    exec,
    tempKnownHosts: () =>
      path.join(KEYS_DIR, `${rec.runId}.known_hosts.probe${n++}`),
    timeoutMs,
  });
  return elapsedMs;
}

// ------------------------------------------------------- operations wiring

/**
 * Open the durable state, importing slice 1's O_EXCL intent journal on the way.
 *
 * The import is conservative and read-only: a legacy record can only ever add a
 * row that FORBIDS a create, and the files themselves are never touched.
 */
async function openStore(): Promise<Store> {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const store = await Store.open(databaseUrl());
  await migrateLegacyIntents(store, INTENTS_DIR);
  return store;
}

/**
 * The same, for the ONE command a deployed provisioner runs.
 *
 * `Store.open` runs the schema statements, and the deployed machine holds a
 * role that is granted rows rather than the schema - measured 2026-08-11, an
 * engine refuses `create table if not exists` from such a role even when the
 * table already exists. So the tick loop opens a runtime store: same bounds
 * proof, same catalog check, no DDL and no writes. Bringing a database up stays
 * `bootstrap`, run by an operator's own role.
 */
async function openStoreForRuntime(): Promise<Store> {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const store = await Store.openRuntime(
    databaseUrl(),
    undefined,
    PROVISIONER_POOL,
  );
  await migrateLegacyIntents(store, INTENTS_DIR);
  return store;
}

/** The instance row for a run. The rule that makes the ceiling mean something
 * lives in instance.ts, where a crash boundary can be tested. */
async function ensureInstance(
  store: Store,
  rec: RunRecord,
  goal: Goal,
  expiresAt?: Date,
): Promise<string> {
  try {
    // Awaited inside the try: the CeilingIsImmutable arm below is what turns a
    // re-run with a different window into a sentence instead of a stack trace.
    return await ensureInstanceRow({ store, rec, goal, expiresAt });
  } catch (err) {
    if (err instanceof CeilingIsImmutable) die(err.message);
    throw err;
  }
}

/**
 * Provider truth for the reconcile pass, when this box has credentials.
 *
 * Absent credentials are not fatal: everything the driver does over SSH works
 * without them, and a reconcile that cannot run just leaves the asset row where
 * it was rather than stopping provisioning.
 */
function reconcileFn():
  | ((asset: { provider_id: string | null }) => Promise<{
      assetState: string;
      ipv4?: string;
      serviceEndsAt?: string;
    } | null>)
  | undefined {
  let adapter: ContaboAdapter;
  try {
    adapter = makeAdapter();
  } catch {
    reporter.line(
      "no provider credentials in the environment: reconcile is off for this run",
    );
    return undefined;
  }
  return async (asset) => {
    if (!asset.provider_id) return null;
    const view = await adapter.get(asset.provider_id);
    const raw = view.raw as { cancelDate?: string | null } | null;
    return {
      assetState: view.assetState,
      ...(view.ipv4 === undefined ? {} : { ipv4: view.ipv4 }),
      ...(raw?.cancelDate ? { serviceEndsAt: raw.cancelDate } : {}),
    };
  };
}

function makeTicker(
  store: Store,
  ownerName?: string,
  /** The provisioner's in-memory hold. Present only in `run`: its absence is
   * what makes a dashboard-requested mint refuse instead of minting a
   * credential into a process that cannot hand it over. */
  deliver?: HandlerDeps["deliver"],
): Ticker {
  const officeDns =
    process.env.ISOMUX_CERT_TARGET &&
    process.env.ISOMUX_ACME_DIRECTORY &&
    process.env.ISOMUX_CF_API &&
    process.env.ISOMUX_CF_ZONE_ID &&
    process.env.ISOMUX_CF_TOKEN
      ? (() => {
          const target = certificateTargetFromEnv(process.env);
          return new CloudflareDns({
            baseUrl: target.cloudflareBaseUrl,
            // Office A records use the configured target zone, like ACME TXT.
            // productionZoneId only pins whether that target is classified live.
            zoneId: target.zoneId,
            apiToken: process.env.ISOMUX_CF_TOKEN ?? "",
            intentsDir: path.join(STATE_ROOT, "certificate-dns-intents"),
          });
        })()
      : undefined;
  const adapter = (() => {
    try {
      return makeAdapter();
    } catch {
      return null;
    }
  })();
  const provider = adapter
    ? {
        reboot: (id: string) => adapter.reboot(id),
        powerOff: (id: string) => adapter.powerOff(id),
        powerOn: (id: string) => adapter.powerOn(id),
        cancel: (id: string) => adapter.cancel(id),
        getAsset: async (id: string) => {
          const view = await adapter.get(id);
          const raw = view.raw as { cancelDate?: string | null } | null;
          return {
            assetState: view.assetState,
            ...(raw?.cancelDate ? { serviceEndsAt: raw.cancelDate } : {}),
          };
        },
        getAddress: (id: string) => adapter.get(id),
      }
    : null;
  const line = (l: string) => reporter.line(l);
  const stripeMode = resolveStripeMode(process.env);
  const stripeKey = stripeKeyFromEnv(stripeMode, process.env);
  const stripeClient = new StripeClient({ key: stripeKey, mode: stripeMode });
  const stripe = {
    client: stripeClient,
    reader: new LiveStripeReader(stripeClient, stripeMode),
  };
  return new Ticker({
    store,
    // The roster lives in `run-roster.ts` so a test can read the ACTUAL list
    // rather than a hand-kept copy of it: the grant matrix is derived from what
    // this command reaches, and a handler added to a literal in here would have
    // widened that silently (reviewer finding, 2026-08-12).
    handlers: tickerHandlerRoster({
      box: {
        exec,
        reporter,
        runsDir: RUNS_DIR,
        keysDir: KEYS_DIR,
        ownerName,
        deliver,
        officeDns,
        certificateEndpoint: process.env.ISOMUX_CERTIFICATE_ENDPOINT,
      },
      provider,
      create: adapter
        ? {
            coordinator: new CreateCoordinator(
              adapter,
              new CreateLatch(store, new IntentJournal(INTENTS_DIR)),
              store,
            ),
            createRequest: (instance) =>
              prepareCreateRun(
                {
                  runsDir: RUNS_DIR,
                  keysDir: KEYS_DIR,
                  exec,
                  secrets: adapter,
                  loginUser: adapter.loginUser,
                },
                instance,
              ),
          }
        : null,
      report: line,
      stripe,
    }),
    reconcile: reconcileFn(),
    report: (line) => reporter.line(line),
  });
}

/**
 * Where the invite seam listens.
 *
 * Loopback unless a deployment says otherwise, which keeps every operator run
 * exactly as it was: a seam that started listening on every interface because
 * of a default would be an authenticated endpoint nobody meant to expose.
 */
function bindAddressOf(args: Map<string, string>): string | undefined {
  const value = args.get("bind");
  return value && value !== "true" ? value : undefined;
}

/**
 * An opaque id for the deployment this process belongs to, if it has one.
 *
 * Passed in rather than read from the environment, so nothing in the control
 * plane knows the name of the platform it is deployed on. Absent locally, where
 * there is no release to have crossed.
 */
function deploymentIdOf(args: Map<string, string>): string | undefined {
  const value = args.get("deployment");
  return value && value !== "true" ? value : undefined;
}

/**
 * What a deployed provisioner says about itself: readiness booleans plus the
 * strictly shaped release identity baked at build time and carried by the
 * existing deployment argument.
 *
 * `ok` is the conjunction of the four properties that make this process able to
 * do its job. `state_persisted` is deliberately NOT one of them: on a first
 * deploy it is correctly false, and a healthy machine must not be reported sick
 * for having been deployed once. Release identity is deliberately not part of
 * `ok`: it tells an operator what is running, not whether the process can work.
 */
async function healthReport(deps: {
  store: Store;
  branchPinned: boolean;
  persisted: boolean;
  lastTickAt: () => number;
  /** Whether this process registered the provider-dependent handlers, asked of
   * the ticker rather than of the environment. NOT a gating boolean: a
   * provisioner with no provider credentials idles correctly by design, and a
   * deployment that has not been given them yet is not a failed one. */
  providerConfigured: () => boolean;
  releaseIdentity: ReleaseIdentity;
}): Promise<Record<string, unknown>> {
  let databaseReachable = false;
  try {
    await deps.store.sqlGet("select 1 as ok");
    databaseReachable = true;
  } catch {
    // The ERROR OBJECT IS DISCARDED, not inspected and not forwarded: the
    // store's seam already strips connection detail, and this surface answers
    // in booleans, so there is nothing here for a message to add.
  }
  const last = deps.lastTickAt();
  // False until BOTH the provisioning and lifecycle passes complete. A missing
  // subscriptions grant leaves `select 1` healthy, so this is the gate that
  // makes that otherwise silent 42501 visible to the deployed probe.
  const tickRecent =
    last > 0 && Date.now() - last < 3 * IDLE_MAINTENANCE_INTERVAL_MS;
  const boundsGoverned = true; // Store.open read both bounds back, or threw.
  return {
    ok: boundsGoverned && deps.branchPinned && databaseReachable && tickRecent,
    bounds_governed: boundsGoverned,
    branch_pinned: deps.branchPinned,
    database_reachable: databaseReachable,
    tick_recent: tickRecent,
    state_persisted: deps.persisted,
    provider_configured: deps.providerConfigured(),
    ...deps.releaseIdentity,
  };
}

/** Non-zero when a human is still owed something. */
async function exitCodeFor(store: Store): Promise<number> {
  return (await store.listInstances()).some(
    (i) => i.attention_state !== "clear",
  )
    ? 1
    : 0;
}

function goalFrom(args: Map<string, string>): Goal {
  const stopAfter = args.get("stop-after");
  if (stopAfter === "first-contact") return "first_contact";
  if (stopAfter === "install") return "installed";
  return args.get("handoff-now") === "true" ? "handed_off" : "live";
}

function newId(prefix: string): string {
  return `${prefix}-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
}

// ----------------------------------------------------------------- commands

async function cmdList(): Promise<void> {
  const creds = credentialsFromEnv();
  const fetchImpl = fetch as unknown as FetchLike;
  const http = new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(creds, fetchImpl),
  });
  const body = (await http.okOrThrow(
    "GET",
    "/v1/compute/instances?size=100",
  )) as {
    data?: {
      instanceId: number;
      displayName?: string;
      productId?: string;
      region?: string;
      status?: string;
      cancelDate?: string | null;
      ipConfig?: { v4?: { ip?: string } };
    }[];
  } | null;
  const rows = body?.data ?? [];
  reporter.line(`${rows.length} instance(s) on the account:`);
  for (const r of rows) {
    reporter.line(
      `  ${r.instanceId}  ${r.ipConfig?.v4?.ip ?? "-"}  ${r.productId ?? "-"}  ` +
        `${r.region ?? "-"}  ${r.status ?? "-"}  cancelDate=${r.cancelDate ?? "none"}  ` +
        `name=${r.displayName || "-"}`,
    );
  }
  audit.record("list_instances", "contabo", "succeeded");
}

async function cmdRecycle(args: Map<string, string>): Promise<void> {
  const instanceId = required(args, "instance");
  const host = required(args, "host");
  const adapter = makeAdapter();
  const runId = args.get("run-id") ?? newId("run");

  const before = await adapter.get(instanceId);
  reporter.line(
    `adopting instance ${instanceId} (${before.assetState}, ${before.powerState}, ${before.ipv4 ?? "no ip"})`,
  );

  const pair = await generateKeyPair(KEYS_DIR, runId, exec);
  const secretId = await adapter.createSshSecret(
    `isomux-cp-${runId}`,
    pair.publicKeyLine,
  );
  audit.record("create_key_secret", instanceId, "succeeded");

  // The recovery record is written and fsynced BEFORE the reinstall, for the
  // same reason the create intent is: a crash after Contabo accepts the request
  // and before we could write would leave a rebuilt box carrying a key whose
  // paths, blob and runId we no longer know - an unexpiring key we cannot even
  // connect to in order to put a ceiling on. `state` is what a restart reads:
  // a reinstall_requested run RESUMES the wait, and never reinstalls again.
  const rec: RunRecord = {
    runId,
    host,
    instanceId,
    ipv4: before.ipv4 ?? die("adopted instance has no ipv4"),
    loginUser: DEFAULT_LOGIN_USER,
    privateKeyPath: pair.privateKeyPath,
    publicKeyPath: pair.publicKeyPath,
    algorithm: pair.algorithm,
    blob: pair.blob,
    knownHostsFile: path.join(KEYS_DIR, `${runId}.known_hosts`),
    secretId,
    state: "reinstall_requested",
  };
  saveRun(rec);

  reporter.step(
    "recycle",
    `reinstalling ${instanceId} with defaultUser=${DEFAULT_LOGIN_USER}`,
  );
  const startedAt = Date.now();
  await adapter.reinstall(instanceId, {
    imageId: UBUNTU_2404_IMAGE_ID,
    publicKeys: [secretId],
    loginUser: DEFAULT_LOGIN_USER,
  });
  audit.record("reinstall", instanceId, "succeeded");

  const waitedMs = await waitForSsh(rec);
  rec.state = "reachable";
  saveRun(rec);
  reporter.line(
    `MEASUREMENT reinstall-to-SSH: ${Math.round((Date.now() - startedAt) / 1000)}s ` +
      `(ssh wait ${Math.round(waitedMs / 1000)}s)`,
  );
  reporter.line(`run ${runId} recorded; login user is ${rec.loginUser}`);
}

/**
 * Provision, as leased operations.
 *
 * Slice 1 ran this as one straight line with three blocking loops inside it.
 * The steps are the same and the driver primitives are the same; what changed is
 * that each one is now a durable row with its own deadlines, so a crash between
 * two of them is a tick that did not happen rather than a flow nobody can
 * resume. --stop-after and --handoff-now became the instance's GOAL, which is
 * why a restart continues to the same place without being told again.
 */
async function cmdProvision(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const expiresAt = accessWindowInstant(args);
  const store = await openStore();
  const goal = goalFrom(args);
  const instanceId = await ensureInstance(store, rec, goal, expiresAt);
  const ticker = makeTicker(store, args.get("owner-name") ?? "Owner");
  if ((await store.operationsFor(instanceId)).length === 0) {
    await ticker.enqueue(instanceId, FIRST_KIND);
  }
  reporter.step(
    "provision",
    `goal=${goal}, ceiling=${expiresAt.toISOString()}`,
  );
  await driveTicks(store, ticker, { forever: false, reporter });
  await printOperations(store, instanceId);
  process.exitCode = await exitCodeFor(store);
}

async function runLifecycleCadence(
  store: Store,
  running: Ticker,
  checkoutReader?: StripeObjectReader,
): Promise<void> {
  if (checkoutReader) {
    const checkouts = await pollPendingCheckouts(
      store,
      checkoutReader,
      store.now(),
      (line) => reporter.line(`Checkout poll: ${line}`),
    );
    if (checkouts.failed > 0) {
      reporter.problem(
        `Checkout poll had ${checkouts.failed} failed candidate(s)`,
      );
    }
  }
  await sweepProvisioningStarts(store, (kind) => running.handles(kind));
  await sweepCustomerKeyRetention(store, (line) => reporter.line(line));
  const summary = await lifecycleTick(store, store.now(), (line) =>
    reporter.line(line),
  );
  if (summary.failed > 0) {
    reporter.problem(
      `lifecycle pass had ${summary.failed} failed subscription(s)`,
    );
  }
}

/**
 * The tick loop as its own process: the provisioner, in miniature.
 *
 * THE ONE PROCESS THAT OWNS ALL FOUR THINGS - the tick, the invite hold, the
 * hold's expiry, and the seam that serves it. That is not an accident of
 * wiring: the hold is process memory, so a URL minted here is collectable only
 * from here, which is exactly why it cannot become a second source of truth.
 */
async function cmdRun(args: Map<string, string>): Promise<void> {
  const store = await openStoreForRuntime();

  // The boot proof, before anything is served or ticked. `Store.open` returning
  // IS the bounds evidence - it read both back from the engine and would have
  // refused otherwise - and the pin below refuses a database that is not the
  // one this deployment was pointed at. Booleans only: neither branch id is
  // printed here or anywhere else.
  const branchPinned = await provePinnedBranch(
    store,
    process.env[BRANCH_PIN_ENV],
  );
  const marker = readAndRefreshMarker(STATE_ROOT, deploymentIdOf(args));
  const releaseIdentity = readReleaseIdentity(undefined, deploymentIdOf(args));
  reporter.line(
    `boot: bounds-governed true, branch-pinned ${branchPinned}, ` +
      `state-persisted ${marker.persisted}, ` +
      `marker-crossed-release ${marker.crossedRelease}, ` +
      `marker-supported ${marker.supported}`,
  );

  const hold = new InviteHold();
  const token = process.env.CONTROL_PLANE_MINT_TOKEN ?? "";
  let lastTickAt = 0;
  // Answered BY THE TICKER, once it exists. The seam is started first, so the
  // health surface reads this through a getter rather than a value: a request
  // that arrives before the ticker is built gets `false`, which is the honest
  // answer at that instant.
  let providerConfigured = false;
  let seam: RunningMintSeam | null = null;
  let checkoutReader: StripeObjectReader | undefined;
  if (token) {
    const stripeMode = resolveStripeMode(process.env);
    const webhookSecret = stripeWebhookSecretFromEnv(stripeMode, process.env);
    const stripeKey = stripeKeyFromEnv(stripeMode, process.env);
    const webhookClient = new StripeClient({
      key: stripeKey,
      mode: stripeMode,
    });
    checkoutReader = new LiveStripeReader(webhookClient, stripeMode);
    const webhook = new WebhookProcessor({
      store,
      reader: checkoutReader,
      secret: webhookSecret,
      mode: stripeMode,
      report: (line) => reporter.line(`stripe webhook: ${line}`),
    });
    const certificateTarget = certificateTargetFromEnv(process.env);
    if (!process.env.ISOMUX_ACME_EMAIL || !process.env.ISOMUX_CF_TOKEN) {
      throw new Error(
        "ISOMUX_ACME_EMAIL and ISOMUX_CF_TOKEN are required for hosted certificate renewal",
      );
    }
    const certificateService = new CertificateService(store, {
      issue: (input) =>
        obtainCertificateWithLego(
          {
            root: path.join(STATE_ROOT, "certificates"),
            target: certificateTarget,
            email: process.env.ISOMUX_ACME_EMAIL ?? "",
            dnsHookPath: path.join(import.meta.dir, "cloudflare-dns-hook.ts"),
            cloudflareToken: process.env.ISOMUX_CF_TOKEN ?? "",
            run: async (argv, environment) => {
              const proc = Bun.spawn(argv, {
                env: { ...process.env, ...environment },
                stdout: "pipe",
                stderr: "pipe",
              });
              const [stdout, stderr, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ]);
              return { stdout, stderr, code };
            },
          },
          input,
        ),
    });
    seam = startMintSeam({
      store,
      hold,
      token,
      port: Number(process.env.CONTROL_PLANE_MINT_PORT ?? "") || undefined,
      hostname: bindAddressOf(args),
      health: () =>
        healthReport({
          store,
          branchPinned,
          persisted: marker.persisted,
          lastTickAt: () => lastTickAt,
          providerConfigured: () => providerConfigured,
          releaseIdentity,
        }),
      report: (line) => reporter.line(line),
      certificates: certificateService,
      webhook,
    });
  } else {
    // Said out loud, because the consequence is invisible otherwise: customer
    // invite requests will refuse rather than mint into a process that has
    // nowhere to hand them over.
    reporter.line(
      "no CONTROL_PLANE_MINT_TOKEN in the environment: the invite seam is off, " +
        "and dashboard invite requests will be refused rather than minted",
    );
  }
  const running = makeTicker(
    store,
    args.get("owner-name") ?? "Owner",
    // Only when the seam is up. A hold nobody can read would turn every
    // customer's invite into a link that silently expires in memory.
    seam ? hold : undefined,
  );
  providerConfigured = PROVIDER_DEPENDENT_KINDS.every((kind) =>
    running.handles(kind),
  );
  reporter.step("run", `holder ${running.holder}`);
  // Said out loud for the same reason the missing seam credential is: a
  // provisioner without provider means idles correctly and looks identical to
  // one that is working, until an operation needs a provider and fails.
  reporter.line(`provider-configured ${providerConfigured}`);
  try {
    await driveTicks(store, running, {
      forever: args.get("once") !== "true",
      reporter,
      cadence: {
        failureLabel: "lifecycle pass failed",
        run: () => runLifecycleCadence(store, running, checkoutReader),
      },
      onTick: () => {
        lastTickAt = Date.now();
      },
      watch: async () => {
        await watchLiveness(store, {
          holder: running.holder,
          report: (line) => reporter.line(line),
        });
      },
    });
  } finally {
    await seam?.stop();
  }
  process.exitCode = await exitCodeFor(store);
}

async function cmdTick(args: Map<string, string>): Promise<void> {
  const store = await openStore();
  const ticker = makeTicker(store, args.get("owner-name") ?? "Owner");
  reporter.line(JSON.stringify(await ticker.once()));
  process.exitCode = await exitCodeFor(store);
}

/** Enqueue one more operation of a kind that is legitimately repeatable. */
async function enqueueOnce(
  store: Store,
  ticker: Ticker,
  instanceId: string,
  kind: OperationKind,
): Promise<void> {
  if (!(await store.activeOperation(instanceId, kind))) {
    await ticker.enqueue(instanceId, kind);
  }
}

/**
 * The tail of provisioning: HTTPS, then the invite, then - only when asked -
 * handoff. Separate from the install because it is the part that depends on DNS.
 */
async function cmdFinish(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const store = await openStore();
  const goal = args.get("handoff-now") === "true" ? "handed_off" : "live";
  const instanceId = await ensureInstance(store, rec, goal);
  const ticker = makeTicker(store, args.get("owner-name") ?? "Owner");
  await enqueueOnce(store, ticker, instanceId, "verify_https");
  await driveTicks(store, ticker, { forever: false, reporter });
  await printOperations(store, instanceId);
  process.exitCode = await exitCodeFor(store);
}

async function cmdMint(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const store = await openStore();
  const instanceId = await ensureInstance(store, rec, "live");
  const ticker = makeTicker(store, args.get("owner-name") ?? "Owner");
  await enqueueOnce(store, ticker, instanceId, "mint_invite");
  await driveTicks(store, ticker, { forever: false, reporter });
  process.exitCode = await exitCodeFor(store);
}

/**
 * Revoke, prove it, destroy our half - as an operation, so a failure raises
 * attention and retries rather than ending at an error message.
 */
async function cmdRevoke(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const store = await openStore();
  const instanceId = await ensureInstance(store, rec, "handed_off");
  const ticker = makeTicker(store);
  await enqueueOnce(store, ticker, instanceId, "revoke_access");
  await driveTicks(store, ticker, {
    forever: args.get("until-proven") === "true",
    reporter,
  });
  await printOperations(store, instanceId);
  process.exitCode = await exitCodeFor(store);
}

function flagLabel(op: {
  inactivity_flagged: number;
  absolute_flagged: number;
}): string {
  const flags = [
    op.inactivity_flagged ? "inactivity" : "",
    op.absolute_flagged ? "absolute" : "",
  ].filter(Boolean);
  return flags.length ? flags.join("+") : "none";
}

/** What the dashboard will render one day, as text. */
async function printOperations(
  store: Store,
  instanceId?: string,
): Promise<void> {
  const instances = instanceId
    ? [await store.getInstance(instanceId)].filter((i) => i !== null)
    : await store.listInstances();
  for (const inst of instances) {
    reporter.line(
      `${inst.id}  ${inst.service_state}  goal=${inst.goal}  ` +
        `attention=${inst.attention_state}${inst.attention_reason ? ` (${inst.attention_reason})` : ""}`,
    );
    for (const op of await store.operationsFor(inst.id)) {
      reporter.line(
        `  ${op.kind.padEnd(24)} ${op.status.padEnd(10)} attempt=${op.attempt} ` +
          `flagged=${flagLabel(op)} ${op.evidence}`,
      );
    }
  }
}

/**
 * Bring the database named by CONTROL_PLANE_DB to schema-ready, and report it.
 *
 * Deliberately NOT through `openStore`: that also imports the legacy intent
 * journal from this box, and a bootstrap must put nothing in a fresh database
 * except the schema. Whether the database is the one intended is the caller's
 * proof to make - `exercises/neon.ts bootstrap` makes it from the provider's
 * API and the engine's own branch id, because an empty database says nothing
 * about which database it is.
 */
async function cmdBootstrap(): Promise<void> {
  const result = await bootstrapDatabase(databaseUrl());
  reportBootstrap(result);
  if (!result.schemaReady || !result.zeroUserData) process.exit(1);
}

async function cmdMigrateCustomerSshKey(): Promise<void> {
  await migrateCustomerSshKeyColumns(databaseUrl());
  reporter.line("customer SSH key columns: ready");
}

async function cmdMigrateHostedCancellation(): Promise<void> {
  await migrateHostedCancellationPolicy(databaseUrl());
  reporter.line("hosted cancellation policy schema: ready");
}

async function cmdMigrateMultiOffice(): Promise<void> {
  await migrateMultiOfficeReservations(databaseUrl());
  reporter.line("multi-office reservation schema: ready");
}

async function cmdMigratePendingCheckouts(): Promise<void> {
  await migratePendingCheckoutColumns(databaseUrl());
  reporter.line("pending Checkout recovery schema: ready");
}

async function cmdOps(args: Map<string, string>): Promise<void> {
  const store = await openStore();
  const run = args.get("run");
  await printOperations(
    store,
    run && run !== "true" ? `inst-${run}` : undefined,
  );
}

/**
 * Grant or revoke the ops floor, by email.
 *
 * The email is a LOOKUP KEY and nothing else: what gets stored, and what every
 * request gate reads, is the account id plus the `is_operator` column. This is
 * the only writer of that column anywhere, and it is a CLI command rather than a
 * route on purpose - an app that can grant its own session the flag has no
 * authorization at all, only the appearance of it.
 */
async function cmdOperator(args: Map<string, string>): Promise<void> {
  const store = await openStore();
  const email = required(args, "email");
  const grant = args.has("grant");
  const revoke = args.has("revoke");
  if (grant === revoke) {
    die("pass exactly one of --grant or --revoke");
  }
  const outcome = await setOperator(store, {
    email,
    on: grant,
    actor: `cli:${process.env.USER ?? "unknown"}`,
  });
  if (!outcome.ok) die(outcome.reason);
  reporter.line(
    outcome.changed
      ? `${outcome.account.id} is ${grant ? "now" : "no longer"} an operator`
      : `${outcome.account.id} was already ${grant ? "" : "not "}an operator`,
  );
}

async function cmdAttention(args: Map<string, string>): Promise<void> {
  const store = await openStore();
  const ack = args.get("ack");
  if (ack && ack !== "true") {
    const n = await acknowledgeAttention(
      store,
      ack,
      args.get("by") ?? "operator",
    );
    // Acknowledging is not clearing: the reasons stay open and the instance
    // keeps reporting needs_operator until the condition itself goes away.
    reporter.line(`acknowledged ${n} open reason(s) on ${ack}`);
  }
  for (const inst of await store.listInstances()) {
    for (const r of await store.openReasons(inst.id)) {
      reporter.line(
        `${inst.id}  ${r.severity.padEnd(8)} ${r.reason}` +
          (r.acknowledged_at ? `  (acknowledged by ${r.acknowledged_by})` : ""),
      );
    }
  }
}

function privilegeArgvFor(loginUser: string): string[] {
  return loginUser === "root" ? [] : ["sudo", "-n"];
}

/**
 * Re-establish contact with a recorded box: wait for our key to authenticate
 * and pin the host key from that same connection.
 *
 * Separate from `recycle` because a box can go away and come back for reasons
 * other than a rebuild - a power cycle across an expiry test, most obviously -
 * and re-pinning has to be a deliberate act rather than a side effect.
 */
async function cmdConnect(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const waited = await waitForSsh(rec);
  // Advance the state, so a run that was interrupted after its rebuild does not
  // sit at reinstall_requested forever and invite someone to rebuild it again.
  if (rec.state === "reinstall_requested") {
    rec.state = "reachable";
    saveRun(rec);
  }
  reporter.line(
    `authenticated as ${rec.loginUser}@${rec.ipv4} after ${Math.round(waited / 1000)}s; ` +
      `host key pinned in ${rec.knownHostsFile}`,
  );
  audit.record("connect", rec.instanceId, "succeeded");
}

/**
 * Continue an interrupted run from what the disk says happened.
 *
 * This is the command that makes the state model real. Without it the operator
 * has to work out by hand which half of a one-command flow already ran, and the
 * safest step is the one nobody thinks of under pressure: WAIT for the box we
 * asked a provider to rebuild, rather than rebuild it again.
 */
async function cmdResume(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const action = await resumeRun(RUNS_DIR, rec, {
    waitForSsh: async (r) => {
      const waited = await waitForSsh(r);
      reporter.line(`reachable after ${Math.round(waited / 1000)}s`);
    },
    firstContact: (r) => {
      reporter.line(
        `next: provision --run ${r.runId} --access-window <window> --stop-after first-contact`,
      );
      return Promise.resolve();
    },
    provision: (r) => {
      reporter.line(
        `next: provision --run ${r.runId} --access-window <window>`,
      );
      return Promise.resolve();
    },
    report: (m) => reporter.line(m),
  });
  audit.record("resume", rec.instanceId, "succeeded", action);
}

async function cmdStatus(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  const ssh = new SshClient(targetFor(rec), exec);
  const tick = parseTick(
    (await ssh.script(`${WRAPPER_REMOTE_PATH} tick\n`)).stdout,
  );
  reporter.line(JSON.stringify(tick));
}

/**
 * Ruling 9: prove Ubuntu 24.04's OpenSSH honours `expiry-time`, rather than
 * assuming it because the version is new enough.
 *
 * Runs on a SCRATCH key, never the provisioning key, so a surprise here cannot
 * lock us out of the box. Prerequisite (Reviewer2): the provisioning key's
 * rewrite must already have passed read-back and the cleanup timer must be
 * armed, so the box is never in a state where a key exists without a ceiling.
 */
async function cmdExpiryTest(args: Map<string, string>): Promise<void> {
  const rec = loadRun(required(args, "run"));
  // R7, enforced on EVIDENCE rather than on a field that provision happened to
  // set early: the provisioning key's ceiling must be confirmed AND the
  // box-local backstop must be armed before any scratch key exists, so the box
  // is never in a state where a key exists without a ceiling.
  if (!rec.expiry) {
    die(
      "run this only after provision has confirmed the provisioning key's expiry",
    );
  }
  if (
    !rec.timerArmed ||
    !timerIsArmed(rec.timerArmed, onCalendarFromExpiry(rec.expiry))
  ) {
    die(
      "the cleanup timer is not proven armed for THIS run's instant; refusing " +
        "to add a scratch key. Re-run provision --stop-after first-contact.",
    );
  }
  const variant = args.get("variant") ?? "boundary";
  const identity = identityFor(rec.loginUser);
  const ssh = new SshClient(targetFor(rec), exec);
  const seconds = Number(args.get("seconds") ?? "120");

  const scratch = await generateKeyPair(
    KEYS_DIR,
    `${rec.runId}-scratch-${variant}`,
    exec,
  );
  const clock = await ssh.script("date -u +%s\n");
  const boxEpoch = Number(clock.stdout.trim());
  const deadline = new Date((boxEpoch + seconds) * 1000);
  const { formatExpiry } = await import("./driver.ts");
  const expiry = formatExpiry(deadline);
  reporter.line(
    `box epoch ${boxEpoch}, ours ${Math.floor(Date.now() / 1000)} ` +
      `(skew ${boxEpoch - Math.floor(Date.now() / 1000)}s); scratch key expires ${expiry}`,
  );

  // The key line is rebuilt on the box from tokens that cannot be re-split.
  // Passing the whole "ssh-ed25519 AAAA... comment" line as one argument does
  // not survive the remote shell - see SshClient.pipe.
  const add = await ssh.pipe(
    [
      ...privilegeArgvFor(identity.loginUser),
      "bash",
      "-s",
      "--",
      identity.authorizedKeysPath,
      expiry,
      scratch.algorithm,
      scratch.blob,
    ],
    'set -euo pipefail\nprintf \'expiry-time="%s" %s %s scratch\\n\' "$2" "$3" "$4" >>"$1"\n' +
      'grep -cF -- "$4" "$1"\n',
  );
  if (add.code !== 0)
    die(`could not add the scratch key: ${add.stderr.trim()}`);

  const scratchTarget: SshTarget = {
    ...targetFor(rec),
    identityFile: scratch.privateKeyPath,
  };
  const before = await new SshClient(scratchTarget, exec).probeAuth();
  reporter.line(`BEFORE the deadline: ${before.kind} (expected authenticated)`);
  // Enforced, not merely printed. A scratch key that never authenticated makes
  // the AFTER assertion vacuous: it would be rejected whether or not sshd
  // honours expiry-time, and the test would pass while proving nothing.
  if (before.kind !== "authenticated") {
    die(
      `the scratch key did not authenticate BEFORE its deadline (${JSON.stringify(before)}). ` +
        `The test proves nothing in this state, so it fails rather than reporting a pass.`,
    );
  }

  if (variant === "powered-off") {
    const adapter = makeAdapter();
    reporter.line("powering the box off across the deadline");
    await adapter.powerOff(rec.instanceId);
    await Bun.sleep((seconds + 60) * 1000);
    reporter.line("powering back on");
    await adapter.powerOn(rec.instanceId);
    await waitForSshWithKey(rec, scratchTarget);
  } else {
    await Bun.sleep((seconds + 20) * 1000);
  }

  const after = await new SshClient(scratchTarget, exec).probeAuth();
  reporter.line(
    `AFTER the deadline: ${JSON.stringify(after)} (expected rejected)`,
  );
  if (after.kind !== "rejected") {
    die(
      `expiry-time did NOT hold: ${after.kind}. The whole access ceiling rests on this.`,
    );
  }
  // Take the scratch line off the box. An expired key is harmless - sshd
  // refuses it - but revocation only removes our provisioning blob, so without
  // this the test would leave its litter behind on a customer's machine.
  const swept = await ssh.pipe(
    [
      ...privilegeArgvFor(identity.loginUser),
      "bash",
      "-s",
      "--",
      identity.authorizedKeysPath,
      scratch.blob,
    ],
    'set -uo pipefail\ngrep -vF -- "$2" "$1" > "$1.tmp" || true\n' +
      'chmod --reference="$1" "$1.tmp" 2>/dev/null || chmod 600 "$1.tmp"\n' +
      'mv -f "$1.tmp" "$1"\ngrep -cF -- "$2" "$1" || true\n',
  );
  if (swept.code !== 0) {
    reporter.problem(`warning: could not sweep the scratch key off the box`);
  }
  destroyPrivateKey(scratch);
  reporter.line(`expiry-time verified (${variant} variant).`);
}

/** Wait for the box to answer at all again after a power cycle. Uses the
 * PROVISIONING key, since the scratch key is expected to be dead by then. */
async function waitForSshWithKey(
  rec: RunRecord,
  _scratch: SshTarget,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const outcome = await new SshClient(targetFor(rec), exec).probeAuth();
    if (outcome.kind !== "inconclusive") return;
    await Bun.sleep(5000);
  }
  die("box did not come back after the power cycle");
}

// -------------------------------------------------------------------- entry

async function main(): Promise<void> {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "list":
      return cmdList();
    case "recycle":
      return cmdRecycle(args);
    case "provision":
      return cmdProvision(args);
    case "connect":
      return cmdConnect(args);
    case "mint":
      return cmdMint(args);
    case "finish":
      return cmdFinish(args);
    case "resume":
      return cmdResume(args);
    case "status":
      return cmdStatus(args);
    case "revoke":
      return cmdRevoke(args);
    case "run":
      return cmdRun(args);
    case "tick":
      return cmdTick(args);
    case "ops":
      return cmdOps(args);
    case "bootstrap":
      return cmdBootstrap();
    case "migrate-customer-ssh-key":
      return cmdMigrateCustomerSshKey();
    case "migrate-hosted-cancellation":
      return cmdMigrateHostedCancellation();
    case "migrate-multi-office":
      return cmdMigrateMultiOffice();
    case "migrate-pending-checkouts":
      return cmdMigratePendingCheckouts();
    case "operator":
      return cmdOperator(args);
    case "attention":
      return cmdAttention(args);
    case "expiry-test":
      return cmdExpiryTest(args);
    default:
      reporter.line(
        "usage: bun control-plane/cli.ts <list|recycle|connect|resume|provision|run|tick|ops|" +
          "attention|operator|finish|mint|status|revoke|expiry-test|bootstrap|migrate-customer-ssh-key|migrate-hosted-cancellation|migrate-multi-office|migrate-pending-checkouts> [--flags]",
      );
      process.exit(2);
  }
}

await main();
