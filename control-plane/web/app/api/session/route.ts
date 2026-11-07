import { auth } from "../../../auth";
import {
  accountSettings,
  officesForAccount,
} from "../../../lib/services.server";
import type { SessionView } from "../../../lib/session-view";

export const dynamic = "force-dynamic";

/**
 * The one cookie-varying thing the two static pages depend on.
 *
 * `/` and `/signin` are prerendered so that a CDN can hold them, which it can
 * only do for a body that is the same for everyone. The part that differs per
 * visitor moves here, where the answer is explicitly uncacheable: `force-dynamic`
 * keeps Next from prerendering it, and `Cache-Control: no-store` keeps anything
 * in front of Next from holding one visitor's answer for the next one.
 *
 * THE ACCOUNT ID IS THE TEST, not merely the presence of a session: a session
 * that never bound to an account is not signed in for anything this app does.
 * That is the same test `/signin` used to make on the server, moved rather than
 * relaxed.
 *
 * The store reads are OPT-IN. The landing page needs the offices and asks with
 * `?offices=1`; the top bar needs only the account's address and asks with
 * `?account=1`; the sign-in page's redirect guard needs only the boolean, and
 * charging it a store read it never uses would put a database round trip in
 * front of a redirect. The signed-out branch returns before any store work at
 * all, which is the branch nearly every request takes.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) return answer({ signedIn: false });

  const email = session.user?.email ?? null;
  const query = new URL(request.url).searchParams;
  const wantsOffices = query.get("offices") === "1";
  if (!wantsOffices && query.get("account") !== "1") {
    return answer({ signedIn: true, email, offices: null });
  }

  // The top bar and the dashboard show the account's address, which an email
  // change moves after the session was issued; the session keeps the one it
  // signed in with.
  if (!wantsOffices) {
    const account = await accountSettings(accountId);
    return answer({
      signedIn: true,
      email: account?.email ?? email,
      offices: null,
    });
  }
  const [offices, account] = await Promise.all([
    officesForAccount(accountId),
    accountSettings(accountId),
  ]);
  return answer({
    signedIn: true,
    email: account?.email ?? email,
    offices: offices.map((office) => ({
      instanceId: office.instanceId,
      officeName: office.officeName,
      hostname: office.hostname,
      ready: office.ready,
      ended: office.ended,
      plan: office.tier,
    })),
  });
}

function answer(view: SessionView): Response {
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
