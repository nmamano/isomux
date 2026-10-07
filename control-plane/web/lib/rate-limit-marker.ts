// Shared by the limiter (server) and the sign-in form (browser): the marker a
// refused sign-in start carries to the sign-in page.

export const RATE_LIMITED_MARKER = "rate_limited";

/** Where a refused sign-in start sends the browser. Fixed: nothing from the
 * request chooses it. */
export const RATE_LIMITED_SIGNIN_URL = `/signin?error=${RATE_LIMITED_MARKER}`;
