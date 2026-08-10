// Who is an operator. A READ, and only a read.
//
// The ops floor's whole authority is one column, `accounts.is_operator`, and
// this module is the only way anything asks about it. It contains no writer on
// purpose: the granting half lives in operator-admin.ts, which the public web
// app's module graph may not reach, so a route that can ask "is this account an
// operator" is structurally unable to answer "yes, now it is".
//
// A column rather than a list of email addresses. An email is a display string
// that Google can change under a stable account, so an address-gated ops floor
// would silently follow the address; and an address in code cannot be audited,
// revoked, or even enumerated by the deployment that runs it.

import type { Store } from "./store.ts";

/**
 * Does this account hold the operator flag RIGHT NOW?
 *
 * Every ops service calls this as its own first act rather than trusting a page
 * or a facade to have done it. A gate one layer above the work is a gate that a
 * second caller of that work does not have.
 */
export async function isOperator(
  store: Store,
  accountId: string,
): Promise<boolean> {
  // FOR SHARE, inside the transaction that the answer is going to guard.
  //
  // The rule this read exists for is that a revoke cannot land BETWEEN the
  // check and the work it authorises. A plain SELECT does not lock, so under
  // this engine a concurrent `update accounts set is_operator = 0` would commit
  // while the verb was still running, and the verb would finish on an authority
  // that had been taken away mid-sentence. A share lock is what the previous
  // engine gave us for free by locking the whole database for writing; this is
  // the same guarantee at the width of one row.
  //
  // FOR KEY SHARE would not do: it only conflicts with writers that change a
  // key, and `is_operator` is not one.
  //
  // Outside a transaction there is nothing to guard - the answer is consumed
  // immediately - and a lock that ends with the statement would only be
  // theatre.
  const row = await store.sqlGet<{ is_operator: number }>(
    "select is_operator from accounts where id = $1" +
      (store.inTransaction() ? " for share" : ""),
    [accountId],
  );
  return row?.is_operator === 1;
}
