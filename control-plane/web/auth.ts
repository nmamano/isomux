// Sign-in, and the providers that reach it.
//
// Google and the email link are the customer's two ways in, and each is
// configured ONLY when its credentials are present: an absent client id or mail
// key means the provider is genuinely not there - no route, no button - rather
// than present and broken. The dev provider is gated twice, on an explicit flag
// AND on not being a production build.
//
// The email link (lib/signin-link-request.server.ts mails it) is a Credentials
// provider, not Auth.js's built-in email provider, which needs a database
// adapter. Its only credential is a signed, single-use token; the address it
// signs in as is the one inside the token, never a field of the post.
//
// THE SESSION CARRIES AN ACCOUNT ID, NOT AN EMAIL. Both providers resolve to a
// durable account before a session exists, and every read and write downstream
// selects on that id. An email is mutable: Google can return the same subject
// with a new address, and a session keyed on the address would then reach a
// different account than the one the subject is durably bound to - while the
// binding quietly kept saying the right thing. The email stays on the session
// as contact and display data.
//
// Sessions are JWTs and there is no database adapter. An adapter would make
// Auth.js a second writer of `accounts`, and slice 3's ownership split exists
// precisely so that every writer of a table can be named.
//
// A JWT cannot be revoked, so each one carries its account's session epoch from
// sign-in, and every session read compares it with the account's (one primary
// key read). An email change or a Google sign-in removal raises the epoch, which
// ends every session issued before it; the route that made the change re-issues
// its own browser's session through keepSession. A session whose epoch cannot be
// read (the store is down) is no session either: Auth.js clears the cookie, so
// a database outage costs a sign-in again rather than leaving a revoked session
// alive.

import NextAuth, { type NextAuthConfig } from "next-auth";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { identityForSignIn, sessionEpochFor } from "./lib/services.server";
import { deploymentSignInTokens } from "./lib/signin-link.server";
import { redactLogText } from "../report";

const devAuthEnabled =
  process.env.CONTROL_PLANE_DEV_AUTH === "1" &&
  process.env.NODE_ENV !== "production";

const googleConfigured = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

const emailLinkConfigured = !!process.env.AUTH_RESEND_KEY;

const providers: NextAuthConfig["providers"] = [];

if (googleConfigured) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

if (emailLinkConfigured) {
  providers.push(
    Credentials({
      id: "email-link",
      name: "Email link",
      credentials: { token: { type: "text" } },
      async authorize(raw) {
        const token = typeof raw.token === "string" ? raw.token : "";
        const redeemed = deploymentSignInTokens()?.redeem(token);
        if (!redeemed?.ok) return null;
        const identity = await identityForSignIn({
          provider: "email-link",
          email: redeemed.email,
        });
        if (!identity.ok) return null;
        return { id: identity.accountId, email: redeemed.email };
      },
    }),
  );
}

if (devAuthEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Developer sign-in",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(raw) {
        const email = typeof raw.email === "string" ? raw.email.trim() : "";
        if (!email || !email.includes("@")) return null;
        const identity = await identityForSignIn({ provider: "dev", email });
        if (!identity.ok) return null;
        return { id: identity.accountId, email };
      },
    }),
  );
}

export const devSignInAvailable = devAuthEnabled;
export const googleSignInAvailable = googleConfigured;
export const emailSignInAvailable = emailLinkConfigured;

/**
 * What keepSession sends through Auth.js's session update. Any browser can post
 * an update with any data, so only this process's own random value re-issues a
 * session at the current epoch; it never leaves the process, because
 * unstable_update runs Auth.js in-process.
 */
const KEEP = randomBytes(32).toString("hex");

function isKeep(data: unknown): boolean {
  const keep =
    typeof data === "object" && data !== null
      ? (data as { keep?: unknown }).keep
      : undefined;
  if (typeof keep !== "string") return false;
  const given = Buffer.from(keep);
  const expected = Buffer.from(KEEP);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  providers,
  logger: {
    error(error) {
      console.error(redactLogText(inspect(error, { depth: 4 })));
    },
    warn(code) {
      console.warn(redactLogText(code));
    },
    debug() {
      /* Production authentication never logs request metadata. */
    },
  },
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  callbacks: {
    async signIn({ account, user, profile }) {
      if (account?.provider !== "google") return true;
      const subject = account.providerAccountId || profile?.sub;
      const email = user.email ?? profile?.email;
      if (!subject || !email) return false;
      // A sign-in that cannot be bound must not become a session: two accounts
      // sharing one Google identity is the state this refuses to create. The
      // account id it resolves to is carried into the token below.
      const identity = await identityForSignIn({
        provider: "google",
        subject,
        email,
        emailVerified: profile?.email_verified === true,
      });
      if (!identity.ok) return false;
      user.id = identity.accountId;
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      if (user?.id) {
        // Written once, at sign-in, from the durable binding.
        const epoch = await sessionEpochFor(user.id);
        if (epoch === null) throw new Error(`account ${user.id} is gone`);
        token.accountId = user.id;
        token.sessionEpoch = epoch;
        return token;
      }
      const accountId = token.accountId;
      if (typeof accountId !== "string") return null;
      // Throws when the store cannot answer: no session (header comment).
      const current = await sessionEpochFor(accountId);
      if (current === null) return null;
      if (trigger === "update" && isKeep(session)) {
        token.sessionEpoch = current;
        return token;
      }
      // A session from before the epoch existed counts as the first.
      return (token.sessionEpoch ?? 0) === current ? token : null;
    },
    session({ session, token }) {
      const accountId = token.accountId;
      if (typeof accountId === "string") session.accountId = accountId;
      return session;
    },
  },
});

export { handlers, auth, signIn, signOut };

/**
 * Re-issue this request's session at its account's current epoch, after a
 * change that ended the account's other sessions.
 */
export async function keepSession(): Promise<void> {
  await unstable_update({ keep: KEEP } as never);
}
