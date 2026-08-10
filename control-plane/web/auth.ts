// Sign-in, and the two providers that reach it.
//
// Google is the product's identity provider, and it is configured ONLY when its
// credentials are present: an absent client id means the provider is genuinely
// not there - no route, no button - rather than present and broken. No Google
// OAuth client exists yet, so every test in this slice signs in through the dev
// provider, which is gated twice, on an explicit flag AND on not being a
// production build.
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

import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { identityForSignIn } from "./lib/services.server";

const devAuthEnabled =
  process.env.CONTROL_PLANE_DEV_AUTH === "1" &&
  process.env.NODE_ENV !== "production";

const googleConfigured = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

const providers: NextAuthConfig["providers"] = [];

if (googleConfigured) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
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
      });
      if (!identity.ok) return false;
      user.id = identity.accountId;
      return true;
    },
    jwt({ token, user }) {
      // Written once, at sign-in, from the durable binding.
      if (user?.id) token.accountId = user.id;
      return token;
    },
    session({ session, token }) {
      const accountId = token.accountId;
      if (typeof accountId === "string") session.accountId = accountId;
      return session;
    },
  },
});
