#!/usr/bin/env bun
// Link a SIGNED-UP instance to a box that already exists, and later ask for our
// access to be removed again.
//
// Slice 4a's acceptance run needs the instance the customer can see to be the
// instance whose operations drive the real box. Every command in cli.ts except
// `run` and `tick` addresses `inst-<runId>` through ensureInstance, so pointing
// one of them at a signed-up instance would create a SECOND instance the
// account cannot see, driving the same box. THIS FILE IS THE PATH, AND
// `cli.ts run` IS WHAT DRIVES IT AFTERWARDS: handlers resolve the run record
// from `instances.run_id` (handlers.ts), so a tick needs nothing else to work
// on a row it did not create.
//
//   bun control-plane/exercises/adopt-run.ts --db <file> --instance inst-<id> \
//       --run <runId> --start
//   bun control-plane/exercises/adopt-run.ts --db <file> --instance inst-<id> \
//       --run <runId> --revoke
//
// EVERY PRECONDITION IS RE-READ AND DECIDED INSIDE THE SAME begin-immediate
// TRANSACTION AS THE WRITES. Anything read before that transaction opens is
// diagnostic only: two cleanup callers must not be able to turn a pre-check
// into duplicate work, and the partial unique index on active operations stays
// the final arbiter underneath both modes.
//
// The kinds this file may open are exactly wait_for_ssh and revoke_access.
// create_instance has no handler anywhere in the CLI, and nothing here can
// reach a paid create.

import { RUNS_DIR } from "../config.ts";
import {
  deadlinesFor,
  newOperationId,
  type OperationKind,
} from "../operations.ts";
import { loadRun } from "../run-record.ts";
import { Store } from "../store.ts";

const ALLOWED_KINDS: OperationKind[] = ["wait_for_ssh", "revoke_access"];

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args.set(argv[i].slice(2), next && !next.startsWith("--") ? next : "true");
  if (next && !next.startsWith("--")) i++;
}

function required(name: string): string {
  const value = args.get(name);
  if (!value || value === "true") throw new Error(`--${name} is required`);
  return value;
}

async function enqueueIn(
  store: Store,
  instanceId: string,
  kind: OperationKind,
  now: number,
): Promise<string> {
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new Error(`this file may not open a ${kind} operation`);
  }
  const d = deadlinesFor(kind);
  const id = newOperationId(kind, await store.nextSeq("audit"));
  await store.enqueue({
    id,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
  });
  return id;
}

async function main(): Promise<void> {
  const dbPath = required("db");
  const instanceId = required("instance");
  const runId = required("run");
  const runsDir = args.get("runs-dir") ?? RUNS_DIR;
  const start = args.get("start") === "true";
  const revoke = args.get("revoke") === "true";
  if (start === revoke) {
    throw new Error("pass exactly one of --start or --revoke");
  }

  const rec = loadRun(runsDir, runId);
  if (!rec) throw new Error(`no run record ${runId} under ${runsDir}`);
  if (!rec.ipv4) throw new Error(`run ${runId} has no address yet`);

  const store = await Store.open(dbPath);
  try {
    const line = await store.tx(async () => {
      const now = store.now();
      const instance = await store.getInstance(instanceId);
      if (!instance) throw new Error(`no instance ${instanceId}`);
      const asset = await store.assetForInstance(instanceId);
      if (!asset)
        throw new Error(`instance ${instanceId} has no provider asset`);
      // Identity, checked the same way in both modes: the box being talked
      // about must be the box this row is about.
      if (instance.name !== rec.host) {
        throw new Error(
          `instance ${instanceId} is named ${instance.name}, but run ${runId} ` +
            `built ${rec.host}: refusing to point one office at another's box`,
        );
      }

      if (start) {
        if (instance.run_id !== null) {
          throw new Error(
            `instance ${instanceId} is already linked to run ${instance.run_id}; ` +
              `a linked instance is never re-pointed`,
          );
        }
        if (asset.provider_id !== null) {
          throw new Error(
            `instance ${instanceId} already carries provider id ` +
              `${asset.provider_id}; refusing to replace a provider asset`,
          );
        }
        if ((await store.operationsFor(instanceId)).length > 0) {
          throw new Error(
            `instance ${instanceId} already has operations; adoption is for a ` +
              `row nothing has run yet`,
          );
        }
        // One transaction: both CAS writes, the audit row and the first
        // operation. A losing CAS throws rather than retrying - an instance
        // somebody else is changing is not one we adopt - so the whole thing
        // rolls back and nothing is half-linked.
        if (
          !(await store.casInstance(instanceId, instance.version, {
            run_id: rec.runId,
          }))
        ) {
          throw new Error(`instance ${instanceId} changed under us; try again`);
        }
        if (
          !(await store.casAsset(asset.id, asset.version, {
            provider_id: rec.instanceId,
            ipv4: rec.ipv4,
            asset_state: "active",
          }))
        ) {
          throw new Error(`asset ${asset.id} changed under us; try again`);
        }
        const opId = await enqueueIn(store, instanceId, "wait_for_ssh", now);
        await store.appendAudit({
          actor: "operator",
          instance_id: instanceId,
          action: "adopt_run",
          target: `${rec.runId}/${rec.instanceId}`,
          outcome: "linked",
          detail: JSON.stringify({ ipv4: rec.ipv4, operation: opId }),
        });
        return `${instanceId} linked to run ${rec.runId} (provider ${rec.instanceId}); ${opId} opened`;
      }

      // --revoke: the mirror image. The instance must ALREADY be this run's.
      if (instance.run_id !== rec.runId) {
        throw new Error(
          `instance ${instanceId} is linked to ${instance.run_id ?? "nothing"}, ` +
            `not to run ${runId}`,
        );
      }
      if (asset.provider_id !== rec.instanceId || asset.ipv4 !== rec.ipv4) {
        throw new Error(
          `instance ${instanceId} points at provider ${asset.provider_id} ` +
            `(${asset.ipv4}), which is not run ${runId}'s box`,
        );
      }
      const verified = (await store.operationsFor(instanceId)).some(
        (op) => op.kind === "verify_https" && op.status === "succeeded",
      );
      if (!verified) {
        throw new Error(
          `instance ${instanceId} has no succeeded verify_https: refusing to ` +
            `revoke access to a box we never proved was live`,
        );
      }
      const active = await store.activeOperation(instanceId, "revoke_access");
      if (active) {
        // Idempotent: no enqueue, no state change. The attempt is still
        // recorded, because an operator trying twice is real history.
        await store.appendAudit({
          actor: "operator",
          instance_id: instanceId,
          action: "adopt_run_revoke",
          target: rec.runId,
          outcome: "already_active",
          detail: JSON.stringify({
            operation: active.id,
            status: active.status,
          }),
        });
        return `${active.id} is already ${active.status}; nothing to do`;
      }
      const proven = (await store.operationsFor(instanceId)).some(
        (op) => op.kind === "revoke_access" && op.status === "succeeded",
      );
      if (proven) {
        throw new Error(
          `run ${runId}'s access was already revoked and proven; there is ` +
            `nothing left to remove`,
        );
      }
      const opId = await enqueueIn(store, instanceId, "revoke_access", now);
      await store.appendAudit({
        actor: "operator",
        instance_id: instanceId,
        action: "adopt_run_revoke",
        target: rec.runId,
        outcome: "enqueued",
        detail: JSON.stringify({ operation: opId }),
      });
      return `${opId} opened; drive it with \`bun control-plane/cli.ts run\``;
    });
    console.log(line);
  } finally {
    await store.close();
  }
}

try {
  // AWAITED: without it the rejection would arrive after this frame has left
  // and the catch below - the whole error report for this exercise - would
  // never run, leaving an unhandled rejection instead of a message.
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
