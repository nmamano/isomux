#!/usr/bin/env bun
// A child process that arms a create and then dies inside the provider call.
//
// This exists because a rejected or abandoned Promise in the test's own process
// is not crash evidence: the capability that permits a create lives in a stack
// frame, and the only honest way to show that losing the process loses it is to
// kill a real process that is holding it.
//
// Usage: arm-and-hang.ts <dbPath> <opId> <intentId> <runsDirUnused>
// Prints ARMED once the pre-call transaction has committed and the provider call
// has begun. The parent kills it at that point.

import { CreateCoordinator } from "../create-coordinator.ts";
import { CreateLatch } from "../create-latch.ts";
import { Store } from "../store.ts";
import type { CreateOutcome, ProviderAdapter } from "../provider.ts";

const [dbPath, opId, intentId] = process.argv.slice(2);
const store = await Store.open(dbPath);
const op = await store.getOperation(opId);
if (!op) throw new Error(`no operation ${opId}`);

const now = Date.now();
// A SHORT lease: this process is about to be killed, and a crashed holder's
// lease has to expire for the next one to adopt the row.
const leased = await store.tryLease(
  op.id,
  op.version,
  "crashed-child",
  now + 1000,
  now,
);
if (!leased) throw new Error("could not lease");

const adapter: ProviderAdapter = {
  async create(): Promise<CreateOutcome> {
    // The pre-call transaction has committed by the time we get here.
    process.stdout.write("ARMED\n");
    await new Promise(() => {});
    throw new Error("unreachable");
  },
  get: () => Promise.reject(new Error("not used")),
  reboot: () => Promise.reject(new Error("not used")),
  powerOff: () => Promise.reject(new Error("not used")),
  powerOn: () => Promise.reject(new Error("not used")),
  cancel: () => Promise.reject(new Error("not used")),
  find: () => Promise.reject(new Error("not used")),
};

const coordinator = new CreateCoordinator(
  adapter,
  new CreateLatch(store),
  store,
);
await coordinator.armAndCreate(
  { intentId, plan: "V153", region: "EU", publicKeys: [] },
  { id: op.id, version: leased.version, holder: "crashed-child" },
);
