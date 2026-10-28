// Shared by the Google sign-in callback (server) and the sign-in form
// (browser): the marker a refused Google sign-in carries to the sign-in page.

export const GOOGLE_REMOVED_MARKER = "GoogleRemoved";

/** Where a Google sign-in for a removed Google account sends the browser. */
export const GOOGLE_REMOVED_SIGNIN_URL = `/signin?error=${GOOGLE_REMOVED_MARKER}`;
