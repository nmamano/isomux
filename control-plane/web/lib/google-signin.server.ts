// The Auth.js signIn callback (auth.ts), out of auth.ts so that it can be
// called without a provider set up.

// From @auth/core, not next-auth: next-auth would bring Next's global types
// into the root typecheck, which imports this module from a test.
import type { Account, Profile, User } from "@auth/core/types";
import { GOOGLE_REMOVED_SIGNIN_URL } from "./google-removed-marker";
import { identityForSignIn } from "./services.server";

/**
 * Bind a Google sign-in to its account, or refuse it. Every other provider
 * resolved its account in its own authorize. True lets the sign-in through,
 * false refuses it, and a path refuses it and sends the browser there.
 */
export async function googleSignIn({
  account,
  user,
  profile,
}: {
  account?: Account | null;
  user: User;
  profile?: Profile;
}): Promise<boolean | string> {
  if (account?.provider !== "google") return true;
  const subject = account.providerAccountId || profile?.sub;
  const email = user.email ?? profile?.email;
  if (!subject || !email) return false;
  // A sign-in that cannot be bound must not become a session: two accounts
  // sharing one Google identity is the state this refuses to create. The
  // account id it resolves to is carried into the token (auth.ts jwt).
  const identity = await identityForSignIn({
    provider: "google",
    subject,
    email,
    emailVerified: profile?.email_verified === true,
  });
  if (!identity.ok) {
    return identity.code === "google-removed"
      ? GOOGLE_REMOVED_SIGNIN_URL
      : false;
  }
  user.id = identity.accountId;
  return true;
}
