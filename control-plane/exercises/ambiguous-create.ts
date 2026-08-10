#!/usr/bin/env bun
// Exercise: an ambiguous create, resolved by find and nothing else.
//
// The money rail forbids a live create, so the create call is faulted AT THE
// TRANSPORT SEAM: the injected fetch throws for POST /v1/compute/instances
// without transmitting it, and passes every other call through to the REAL
// account with real credentials. So `find` runs against real data while the paid
// endpoint is never reached - three independent layers stand between this script
// and a second box (no CLI path enqueues create_instance, the transport refuses
// to send it, and the latch forbids a second call for the intent).
//
// The live-create leg therefore stays "not live-verified", deliberately.
//
// Usage (credentials sourced by the caller):
//   bun control-plane/exercises/ambiguous-create.ts <instanceId>
//
// The exact-adopt arm needs a row on the account carrying our intent stamp. The
// manager approved a displayName PATCH on the test box for exactly this, on
// these conditions: displayName is the only field touched, it is restored in
// this script's own cleanup, and both the change and the restore are read back
// into the transcript. PUT is the REINSTALL endpoint and is never used here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContaboAdapter, intentStamp } from "../contabo/adapter.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "../contabo/auth.ts";
import { ContaboHttp } from "../contabo/http.ts";
import { CreateCoordinator } from "../create-coordinator.ts";
import { CreateLatch } from "../create-latch.ts";
import { createInstanceHandler } from "../handlers.ts";
import { Reporter } from "../report.ts";
import { Store } from "../store.ts";
import { Ticker } from "../tick.ts";
import {
  databaseUrl,
  UBUNTU_2404_IMAGE_ID,
  DEFAULT_LOGIN_USER,
} from "../config.ts";
import { SpawnExec } from "../ssh.ts";

const instanceId = process.argv[2];
if (!instanceId) {
  console.error("usage: ambiguous-create.ts <contabo instance id>");
  process.exit(2);
}

const reporter = new Reporter();
const INTENT = `s2-ambiguous-${Date.now()}`;
const STAMP = intentStamp(INTENT);

let createAttempts = 0;
const realFetch = fetch as unknown as FetchLike;

/** Real for everything except the one endpoint that spends money. */
const faultedFetch: FetchLike = (url, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && String(url).includes("/v1/compute/instances")) {
    createAttempts++;
    // Nothing is transmitted. This is what an ambiguous create looks like from
    // our side: the request may or may not have been delivered, and we cannot
    // tell - except that here we know it was not, which is the only reason this
    // is safe to run at all.
    return Promise.reject(new Error("socket hang up (faulted at the seam)"));
  }
  return realFetch(url, init);
};

const tokens = new TokenProvider(credentialsFromEnv(), realFetch);
const http = new ContaboHttp({ fetchImpl: faultedFetch, tokens });
const adapter = new ContaboAdapter({
  http,
  imageId: UBUNTU_2404_IMAGE_ID,
  loginUser: DEFAULT_LOGIN_USER,
});

// Keys and run records still live in a throwaway directory; the database
// does not, because the store speaks to a server now. Point
// CONTROL_PLANE_DB at a SCRATCH database: this writes rows.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ambiguous-"));
const store = await Store.open(databaseUrl());
await store.createInstance({
  id: "inst-ambiguous",
  run_id: null,
  name: "cp-ambiguous.test.isomux.app",
  plan: "V153",
  region: "EU",
  service_state: "provisioning",
  goal: "live",
  access_window_expires_at: null,
});

const ticker = new Ticker({
  store,
  handlers: [
    createInstanceHandler({
      exec: new SpawnExec(),
      reporter,
      runsDir: dir,
      keysDir: dir,
      coordinator: new CreateCoordinator(
        adapter,
        new CreateLatch(store),
        store,
      ),
      createRequest: () => ({
        intentId: INTENT,
        plan: "V153",
        region: "EU",
        publicKeys: [],
      }),
    }),
  ],
  report: (line) => reporter.line(line),
});

/**
 * Tick once the operation is actually DUE.
 *
 * Backoff is persisted in next_attempt_at, so a tick fired straight after the
 * previous one does nothing at all - which would make this exercise assert
 * against a find that never ran. Sleeping belongs out here in the driver script;
 * nothing sleeps inside a tick.
 */
async function tickWhenDue(): Promise<void> {
  for (;;) {
    const due = (await store.dueOperations(Date.now(), 8)).some(
      (o) => o.instance_id === "inst-ambiguous",
    );
    if (due) break;
    await Bun.sleep(2000);
  }
  await ticker.once();
}

async function show(label: string): Promise<void> {
  const op = (await store.operationsFor("inst-ambiguous")).find(
    (o) => o.kind === "create_instance",
  );
  const inst = await store.getInstance("inst-ambiguous");
  const intent = await store.getIntent(INTENT);
  reporter.line(
    `${label}: op=${op?.status} attempt=${op?.attempt} evidence=${op?.evidence} ` +
      `intent=${intent?.state} attention=${inst?.attention_state}`,
  );
}

async function displayNameOf(): Promise<string> {
  const body = (await http.okOrThrow(
    "GET",
    `/v1/compute/instances/${instanceId}`,
  )) as { data?: { displayName?: string }[] } | null;
  return body?.data?.[0]?.displayName ?? "";
}

async function setDisplayName(name: string): Promise<void> {
  // PATCH, not PUT. PUT with an imageId is the reinstall endpoint.
  await http.okOrThrow("PATCH", `/v1/compute/instances/${instanceId}`, {
    displayName: name,
  });
}

const originalName = await displayNameOf();
reporter.line(
  `box ${instanceId} displayName before: ${JSON.stringify(originalName)}`,
);

try {
  // 1. The faulted create.
  await ticker.enqueue("inst-ambiguous", "create_instance");
  await ticker.once();
  await show("after the faulted create");

  // 2. Quarantine with nothing on the account carrying our stamp: find proves
  //    absence, and the operation keeps waiting rather than opening a second
  //    intent.
  await tickWhenDue();
  await show("quarantine, nothing stamped");

  // 3. The exact-adopt arm. Stamp the box, read it back, and let find see it.
  await setDisplayName(STAMP);
  reporter.line(
    `displayName after PATCH (read back): ${await displayNameOf()}`,
  );
  await tickWhenDue();
  await show("quarantine, stamp present");
} finally {
  // 4. Restore, read back, and prove the stamp is gone so no later find can
  //    adopt this box.
  await setDisplayName(originalName);
  reporter.line(
    `displayName restored (read back): ${JSON.stringify(await displayNameOf())}`,
  );
  const after = await adapter.find(INTENT);
  reporter.line(`find(${INTENT}) after the restore: ${JSON.stringify(after)}`);
}

reporter.line(`POSTs to the create endpoint that were transmitted: 0`);
reporter.line(`create attempts intercepted at the seam: ${createAttempts}`);
reporter.line(
  `intent rows: ${JSON.stringify((await store.listIntents()).map((i) => i.state))}`,
);
reporter.line(
  `attention: ${JSON.stringify(
    (await store.openReasons("inst-ambiguous")).map((r) => r.reason),
  )}`,
);
await store.close();
fs.rmSync(dir, { recursive: true, force: true });
