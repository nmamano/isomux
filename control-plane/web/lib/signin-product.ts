// The two products that share the one account system on cloud.isomux.com, and
// the paths each one's sign-in uses. Every surface that differs by product
// (the sign-in form, its guard, the policy links, the emailed link, the error
// landings) reads this one table, so a new surface cannot drift.

export type SignInProduct = "hosted" | "enterprise";

/** The enterprise pages' tab title: the product's name (app/layout.tsx gives
 * every other page "Hosted Isomux"). */
export const ENTERPRISE_TITLE = "Isomux for Enterprise";

export const SIGNIN_PRODUCTS: Record<
  SignInProduct,
  { signInPath: string; home: string }
> = {
  hosted: { signInPath: "/signin", home: "/" },
  enterprise: { signInPath: "/enterprise/signin", home: "/enterprise" },
};

/** The product a request or a link names. Anything but "enterprise" is
 * Hosted: the value only picks a path from the table above. */
export function signInProductOf(value: unknown): SignInProduct {
  return value === "enterprise" ? "enterprise" : "hosted";
}

/** Where this tab records the product of the last sign-in it started. Auth.js
 * sends every failed sign-in to the one page it knows, /signin, and that page
 * reads this to move a failed enterprise sign-in on to the enterprise page. */
const STARTED_KEY = "isomux.signin-product";

/** Records the product of a sign-in this tab is about to start. Every start
 * records, so a Hosted sign-in after an enterprise one is Hosted again. */
export function recordSignInStart(product: SignInProduct): void {
  try {
    sessionStorage.setItem(STARTED_KEY, product);
  } catch {
    // Storage blocked: a failed enterprise sign-in then shows on /signin.
  }
}

/** The product of the last sign-in this tab started, or null. */
export function startedSignInProduct(): SignInProduct | null {
  try {
    const value = sessionStorage.getItem(STARTED_KEY);
    return value === null ? null : signInProductOf(value);
  } catch {
    return null;
  }
}
