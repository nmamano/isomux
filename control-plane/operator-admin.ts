// Granting and revoking the operator flag. THE ONLY WRITER OF `is_operator`.
//
// Split from operator.ts, which reads it, because the public web app reaches the
// reader through the ops services and must never be able to reach this: an app
// that can grant its own session the operator flag has no ops-floor authz at
// all, only the appearance of it. The boundary test forbids this module in the
// app's graph.
//
// It is also deliberately not reachable through `casAccount`: that setter's
// patch type excludes the column, so "raise my own privilege" is not expressible
// through the generic account CAS either.
//
// Called by the CLI, which resolves an email to an account id for convenience.
// The email is a LOOKUP KEY and nothing more - the authority stored, and the
// authority every request gate reads, is the account id plus the column.

import { accountByEmail, type AccountRow } from "./stripe/billing-store.ts";
import type { Store } from "./store.ts";

export type OperatorChange =
  | { ok: true; account: AccountRow; changed: boolean }
  | { ok: false; reason: string };

export async function setOperator(
  store: Store,
  args: { email: string; on: boolean; actor: string },
): Promise<OperatorChange> {
  return store.tx(async () => {
    // Re-read inside the transaction, like every other transition here: a check
    // in front of a write is a check two callers can both pass.
    const account = await accountByEmail(store, args.email);
    if (!account) {
      return {
        ok: false as const,
        reason: `no account with that address; sign in once before granting it`,
      };
    }
    const want = args.on ? 1 : 0;
    if (account.is_operator === want) {
      return { ok: true as const, account, changed: false };
    }
    const updated = await store.sqlGet<AccountRow>(
      "update accounts set is_operator = $1, updated_at = $2, version = version + 1 " +
        "where id = $3 and version = $4 returning *",
      [want, store.now(), account.id, account.version],
    );
    if (!updated) {
      return {
        ok: false as const,
        reason: `account ${account.id} moved while its operator flag was being set`,
      };
    }
    // Audited, because "who could see customer data, and since when" is exactly
    // the question this column will one day have to answer.
    await store.appendAudit({
      actor: args.actor,
      instance_id: null,
      action: args.on ? "grant_operator" : "revoke_operator",
      target: account.id,
      outcome: "succeeded",
      detail: null,
    });
    return { ok: true as const, account: updated, changed: true };
  });
}
