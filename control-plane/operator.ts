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
export function isOperator(store: Store, accountId: string): boolean {
  const row = store.db
    .query<
      { is_operator: number },
      [string]
    >("select is_operator from accounts where id = ?")
    .get(accountId);
  return row?.is_operator === 1;
}
