import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { SignInForm } from "./signin-form";

/**
 * The sign-in page, and the guard that keeps a signed-in visitor off it.
 *
 * It is a SERVER component and deliberately dynamic. The page used to be a
 * client component, which meant it was prerendered and could not know whether
 * anyone was signed in - so it rendered "Continue with Google" to a visitor who
 * already had a session, and the only way out was to notice and navigate away.
 * Session awareness cannot be statically prerendered, so `force-dynamic` here is
 * the cost of asking the question at all.
 *
 * The redirect is the second half of the fix for the loop measured on
 * 2026-08-11; the first half is that both providers now name `/` as their
 * return target. Either alone would have ended the loop. Both together also
 * close the case where a visitor reaches `/signin` by any other route while
 * holding a session.
 */
export const dynamic = "force-dynamic";

export default async function SignIn() {
  const session = await auth();
  // The ACCOUNT ID is the test, not merely the presence of a session: a session
  // that never bound to an account is not signed in for anything this app does.
  if (session?.accountId) redirect("/");
  return <SignInForm />;
}
