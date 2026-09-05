"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSessionProbe } from "../../lib/use-session";

/**
 * The guard that keeps a signed-in visitor off the sign-in page.
 *
 * It renders nothing. It exists so that `page.tsx` can be a prerendered shell
 * and still act on a session, and it is kept out of `signin-form.tsx` so that the
 * form stays a form and its unauthenticated render is unchanged.
 *
 * THE 2026-08-11 LOOP, and why this is not it. That defect was a prerendered
 * client page that COULD NOT KNOW a session existed, so it offered to sign in a
 * visitor who already had one and there was no way out but to navigate away by
 * hand. Both halves of the fix survive here: every `signIn` call still names `/`
 * as its return target (see `signin-form.tsx`), and a signed-in visitor is still
 * sent to `/` - now from the browser, once the probe answers, instead of from the
 * server before the page renders. The way out is automatic, which is the property
 * that was missing.
 *
 * `replace`, not `push`: Back must not restore the page the visitor was just
 * moved off.
 *
 * The account-id test lives in `/api/session`, which answers `signedIn` only for
 * a session bound to an account.
 */
export function SignedInRedirect(): null {
  const router = useRouter();
  const probe = useSessionProbe();

  useEffect(() => {
    if (probe.state === "signed-in") router.replace("/");
  }, [probe.state, router]);

  return null;
}
