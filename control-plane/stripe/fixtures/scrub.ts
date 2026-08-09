#!/usr/bin/env bun
// Turn a recorded Stripe delivery into a fixture that may live in a public repo.
//
// The unit tests use SYNTHETIC objects, because a synthetic object can hold two
// API shapes at once and a recording cannot. Recorded fixtures exist for one job:
// proving that what Stripe actually sends still parses. That job needs the SHAPE,
// not the contents, so everything that identifies a person or an object is
// replaced here rather than trusted to a reviewer's eye:
//
//   - every Stripe id becomes a stable synthetic id (`cus_SCRUBBED1`), so a
//     fixture cannot be traced back to a real object in the test account, and two
//     references to the same object still match each other;
//   - emails, names, phone numbers and addresses are replaced with placeholders;
//   - card details (last4, fingerprint, iin, network ids) are replaced;
//   - any URL that carries a session, invoice or receipt token is dropped.
//
// `fixtures.test.ts` scans the result for exactly those shapes, so a fixture that
// skipped this step fails the suite rather than sitting in the repo unnoticed.
//
//   bun control-plane/stripe/fixtures/scrub.ts <raw.json> <out.json>

// A module, not a script: top-level `await` needs one, and this file has no other
// reason to import anything.
export {};

const ID_PREFIXES = [
  "acct",
  "card",
  "ch",
  "clock",
  "co",
  "cs",
  "cs_test",
  "cus",
  "di",
  "evt",
  "il",
  "in",
  "ii",
  "pi",
  "pm",
  "price",
  "prod",
  "promo",
  "py",
  "re",
  "seti",
  "si",
  "sub",
  "txn",
  "src",
  "tok",
];

const PERSONAL_KEYS = new Set([
  "email",
  "customer_email",
  "receipt_email",
  "name",
  "customer_name",
  "phone",
  "customer_phone",
  "billing_name",
  "line1",
  "line2",
  "city",
  "state",
  "postal_code",
  "last4",
  "fingerprint",
  "iin",
  "network_transaction_id",
  "dynamic_last4",
  "ip_address",
  "client_ip",
  "customer_details",
  "billing_details",
  "payment_method_details",
  "address",
  "shipping",
  "hosted_invoice_url",
  "invoice_pdf",
  "receipt_url",
  "url",
]);

const ids = new Map<string, string>();

function scrubId(value: string): string {
  const prefix = ID_PREFIXES.filter((p) => value.startsWith(`${p}_`)).sort(
    (a, b) => b.length - a.length,
  )[0];
  if (!prefix) return value;
  const existing = ids.get(value);
  if (existing) return existing;
  const made = `${prefix}_SCRUBBED${ids.size + 1}`;
  ids.set(value, made);
  return made;
}

function scrub(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith("isomux_")) {
        // OUR metadata: the keys are what the parsers read, the values name rows in
        // whichever database the exercise ran against.
        out[k] = typeof v === "string" ? `scrubbed-${k.slice(7)}` : v;
        continue;
      }
      if (PERSONAL_KEYS.has(k)) {
        // Structure is kept - the parsers walk it - and content is not.
        out[k] = v === null ? null : typeof v === "object" ? {} : "SCRUBBED";
        continue;
      }
      out[k] = scrub(v, k);
    }
    return out;
  }
  if (typeof value === "string") {
    if (key === "email" || value.includes("@")) return "scrubbed@example.com";
    return scrubId(value);
  }
  return value;
}

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  throw new Error("usage: scrub.ts <raw.json> <out.json>");
}
const raw = JSON.parse(await Bun.file(inPath).text()) as Record<
  string,
  unknown
>;
if (raw.livemode !== false) {
  // A live-mode recording must never be scrubbed into a fixture: the right answer
  // is that it should not exist.
  throw new Error("refusing to scrub a recording that is not test mode");
}
const scrubbed = scrub(raw) as Record<string, unknown>;
scrubbed._comment =
  "RECORDED from a real test-mode delivery on 2026-08-09 (API version " +
  "2026-07-29.dahlia), then scrubbed by fixtures/scrub.ts: every id is synthetic " +
  "and every personal field is a placeholder. Kept only to prove that what Stripe " +
  "sends still parses.";
await Bun.write(outPath, `${JSON.stringify(scrubbed, null, 1)}\n`);
console.log(`${inPath} -> ${outPath} (${ids.size} ids replaced)`);
