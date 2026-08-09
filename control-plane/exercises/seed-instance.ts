#!/usr/bin/env bun
// Stand in for the signup flow that slice 4 will own.
//
// Billing raises attention on an INSTANCE (the design puts the attention columns
// there), and it enqueues the suspension operation against an instance too. In the
// product, signup creates that row and passes its id to Checkout as metadata; until
// slice 4 exists, this is what the live billing exercises use instead.
//
// It writes only the two rows a provisioned box would already have. Nothing here
// talks to a provider, and nothing here touches Stripe.
//
// --provider-id is REQUIRED and has no default. A tracked helper that defaulted to
// a real provider id would write a durable row pointing at a real box, and the
// moment some future command registers the power_off handler a copied exercise
// could power it off. The live exercise passes the real id explicitly, under the
// rail that says nothing in this slice acts on a real box.
//
//   bun control-plane/exercises/seed-instance.ts --db /tmp/x.db --id inst-cp3 \
//     --provider-id 999999999 --name cp3.test.isomux.app [--ipv4 203.0.113.10]

import { Store } from "../store.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args.set(argv[i].slice(2), next && !next.startsWith("--") ? next : "true");
  if (next && !next.startsWith("--")) i++;
}

const dbPath = args.get("db");
const id = args.get("id");
const providerId = args.get("provider-id");
if (!dbPath || !id || !providerId || providerId === "true") {
  throw new Error(
    "--db, --id and --provider-id are all required. --provider-id has NO default: " +
      "a default would bind this row to a real box. Use an obviously synthetic id " +
      "(999999999) unless an exercise genuinely needs the real one.",
  );
}
const store = new Store(dbPath);
if (store.getInstance(id)) {
  console.log(`${id} already exists`);
} else {
  store.tx(() => {
    store.createInstance({
      id,
      run_id: null,
      name: args.get("name") ?? `${id}.test.isomux.app`,
      plan: "V153",
      region: "EU",
      // A box the customer already has: billing suspends what is live.
      service_state: "live",
      goal: "handed_off",
      access_window_expires_at: null,
    });
    store.createAsset({
      id: `asset-${id}`,
      instance_id: id,
      provider: "contabo",
      provider_id: providerId,
      intent_id: null,
      asset_state: "active",
      // No default address either: an absent one is honest, and the asset column is
      // nullable precisely because we do not always know it.
      ipv4: args.get("ipv4") === "true" ? null : (args.get("ipv4") ?? null),
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: store.now() + 60_000,
    });
  });
  console.log(`${id} seeded (provider ${providerId})`);
}
store.close();
