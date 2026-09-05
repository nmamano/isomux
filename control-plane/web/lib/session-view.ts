/**
 * What the browser is told about the visitor's session.
 *
 * The landing page and the sign-in page are prerendered as static shells, so
 * neither can ask `auth()` while it renders. They ask this shape instead, over
 * `/api/session`, and swap in the signed-in content when it comes back.
 *
 * THE OFFICE LIST IS A NAMED FOUR FIELDS, not the projection. `officesForAccount`
 * returns `ProgressView[]`, which carries the ssh command, the access window, the
 * handoff, the subscription and the lifecycle. None of that reaches the browser
 * today: the page renders on the server and only these four fields survive into
 * HTML. Handing the whole projection to the client would widen what the browser
 * holds as a side effect of a caching change, so the route maps down to exactly
 * what the card draws.
 */

/** One office, as the landing page's card draws it. */
export interface OfficeCard {
  instanceId: string;
  officeName: string;
  hostname: string;
  ready: boolean;
}

/**
 * `offices` is `null` when the caller did not ask for it, which is not the same
 * as an account with no offices - that is `[]`. The sign-in page's guard needs
 * only to know a session exists, and making it wait for the projection would put
 * a database round trip in front of a redirect that does not use the answer.
 */
export type SessionView =
  | { signedIn: false }
  | { signedIn: true; email: string | null; offices: OfficeCard[] | null };
