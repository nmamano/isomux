// The account id the session carries.
//
// It is declared rather than cast at each use because it is the authorization
// identity of this app: a reader should find it in the type of `session`, not
// in a `as string` somewhere in a route handler.

import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** The durable control-plane account. The tenant key for every read and
     * write; the session's email is contact data. */
    accountId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accountId?: string;
  }
}
