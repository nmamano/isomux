import { SignedInRedirect } from "./signed-in-redirect";
import { SignInForm } from "./signin-form";

/**
 * The sign-in page, prerendered, and the guard that keeps a signed-in visitor
 * off it.
 *
 * It used to be a dynamic server component that asked `auth()` and redirected
 * before rendering. That answered the session question in the one place a shared
 * cache can never reuse, so the page cost every visitor an origin round trip to
 * be told what almost all of them already knew: they are signed out. The shell is
 * the same for all of them, so it is prerendered, and the session question moved
 * to `SignedInRedirect`, which asks `/api/session` from the browser.
 *
 * The redirect target is unchanged and so is the reason for it: see the loop
 * measured on 2026-08-11, written up in `signed-in-redirect.tsx`. Both providers
 * name `/`, and a signed-in visitor who reaches `/signin` by any route still ends
 * up on `/`.
 *
 * `dynamic = "error"`: an `auth()` call added back to this file must fail the
 * build rather than silently make the page uncacheable again.
 */
export const dynamic = "error";

export default function SignIn() {
  return (
    <>
      <SignedInRedirect />
      <SignInForm />
    </>
  );
}
