#!/usr/bin/env bun
// Exercise: the suspend and resume legs, observed against the real box.
//
// power_off and power_on are the only two operations whose whole meaning is a
// state change we cannot see from inside the office (ruling 3 leaves us no way
// to stop or start a service from within), so the only honest proof is a probe
// from outside: the office answers, then it does not, then it answers again.
//
// It drives the REAL HANDLERS rather than the adapter, because what is being
// proven is the operation path - budget claim, audit rows, evidence including
// the `poweredOffAt` the retention month is measured from - and not merely that
// Contabo has a power endpoint.
//
// GUARDED to instance 203474835, and it powers the box back ON in a finally:
// leaving somebody's server switched off because a script threw is not an
// acceptable failure mode, even for a test box.
//
// Usage (credentials sourced by the caller):
//   bun control-plane/exercises/power-cycle.ts <hostname>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContaboAdapter } from "../contabo/adapter.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "../contabo/auth.ts";
import { ContaboHttp } from "../contabo/http.ts";
import { UBUNTU_2404_IMAGE_ID, DEFAULT_LOGIN_USER } from "../config.ts";
import { probeLiveness } from "../liveness.ts";
import { powerOnHandler } from "../resume.ts";
import { Store } from "../store.ts";
import { powerOffHandler } from "../stripe/suspension.ts";
import { RemoteBudget, type HandlerContext } from "../tick.ts";

const ALLOWED_PROVIDER_ID = "203474835";
const HOST = process.argv[2] ?? "cp2.test.isomux.app";
const IPV4 = "169.58.97.2";

const started = Date.now();
const t = (): string => `T+${Math.round((Date.now() - started) / 1000)}s`;

const fetchImpl = fetch as unknown as FetchLike;
const adapter = new ContaboAdapter({
  http: new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(credentialsFromEnv(), fetchImpl),
  }),
  imageId: UBUNTU_2404_IMAGE_ID,
  loginUser: DEFAULT_LOGIN_USER,
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-power-"));
const store = new Store(path.join(dir, "cp.db"));
const instance = store.createInstance({
  id: "inst-power",
  run_id: null,
  name: HOST,
  plan: "V153",
  region: "EU",
  service_state: "live",
  goal: "live",
  access_window_expires_at: null,
});
const asset = store.createAsset({
  id: "asset-power",
  instance_id: instance.id,
  provider: "contabo",
  provider_id: ALLOWED_PROVIDER_ID,
  intent_id: null,
  asset_state: "cancel_scheduled",
  ipv4: IPV4,
  service_ends_at: null,
  host_key_fingerprint: null,
  next_reconcile_at: 0,
});

function contextFor(id: string, kind: string): HandlerContext {
  const op = store.enqueue({
    id,
    instance_id: instance.id,
    kind,
    inactivity_deadline_at: Date.now() + 300_000,
    absolute_deadline_at: Date.now() + 1_800_000,
    evidence: { reason: "cancellation", subscription: "sub_probe" },
  });
  return {
    store,
    op,
    instance,
    asset,
    fence: { id: op.id, version: op.version, holder: "probe" },
    budget: new RemoteBudget(Date.now() + 60_000, Date.now() + 300_000, () =>
      Date.now(),
    ),
    now: Date.now(),
    report: (line) => console.log(`  ${line}`),
    audit: (action, outcome, detail) =>
      console.log(`  audit ${action}:${outcome}${detail ? ` ${detail}` : ""}`),
  };
}

async function rung(): Promise<string> {
  const result = await probeLiveness(HOST, {}, IPV4);
  return result.rung;
}

/** Poll until the ladder reports what we are waiting for, or give up loudly. */
async function until(
  want: (r: string) => boolean,
  label: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await rung();
    console.log(`${t()}  liveness ${r}`);
    if (want(r)) return r;
    if (Date.now() > deadline) {
      throw new Error(`${label}: still ${r} after ${timeoutMs}ms`);
    }
    await Bun.sleep(10_000);
  }
}

let failure: Error | null = null;
try {
  console.log(`${t()}  before: liveness ${await rung()}`);

  console.log(`${t()}  power_off`);
  const off = await powerOffHandler({
    powerOff: (id) => adapter.powerOff(id),
    report: (l) => console.log(`  ${l}`),
  }).run(contextFor("op-power_off-probe", "power_off"));
  console.log(
    `${t()}  power_off -> ${off.kind} ${JSON.stringify(off.evidence)}`,
  );

  await until((r) => r !== "ok", "the office never stopped answering", 300_000);

  console.log(`${t()}  power_on`);
  const on = await powerOnHandler({
    powerOn: (id) => adapter.powerOn(id),
    report: (l) => console.log(`  ${l}`),
  }).run(contextFor("op-power_on-probe", "power_on"));
  console.log(`${t()}  power_on -> ${on.kind} ${JSON.stringify(on.evidence)}`);

  await until((r) => r === "ok", "the office never came back", 900_000);
  console.log(`${t()}  RECOVERED: the office is serving again`);
} catch (err) {
  failure = err instanceof Error ? err : new Error(String(err));
} finally {
  // ALWAYS leave the box on. A thrown script must not be the reason a server
  // stays down.
  try {
    const view = await adapter.get(ALLOWED_PROVIDER_ID);
    if (view.powerState !== "running") {
      console.log(`${t()}  SAFETY: powering back on (${view.powerState})`);
      await adapter.powerOn(ALLOWED_PROVIDER_ID);
    }
    console.log(
      `${t()}  final provider state: ${JSON.stringify({
        assetState: view.assetState,
        powerState: view.powerState,
      })}`,
    );
  } catch (err) {
    console.error(`SAFETY CHECK FAILED: ${String(err)}`);
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.message);
  process.exit(1);
}
