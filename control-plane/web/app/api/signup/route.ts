import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  continueSignup,
  signUpOffice,
  signupPageState,
} from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * The signup POST.
 *
 * The session's ACCOUNT ID is the only account selector: the form carries a
 * name, a plan and an optional code, and nothing it says is trusted as
 * identity.
 * A refusal comes back to the form with its reason; a success is a redirect to
 * Stripe's own hosted page, which is the only place a card is ever entered.
 */
export async function POST(request: Request): Promise<Response> {
  // BEFORE THE FORM IS READ AND BEFORE ANYTHING IS CREATED. This route writes
  // durable rows and spends at Stripe on the strength of a cookie, so a post
  // from anywhere but this deployment's own page is refused outright - and a
  // refusal here has read nothing, written nothing and called nobody.
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });

  const session = await auth();
  const accountId = session?.accountId;
  const here = new URL(request.url).origin;
  if (!accountId) return Response.redirect(`${here}/signin`, 303);

  const form = await request.formData();
  // A form field can be a File, and stringifying one yields "[object Object]".
  // Anything that is not text is not an office name.
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const officeName = field("officeName");
  const customerSshKey = field("customerSshKey");
  const state = await signupPageState(accountId);
  if (state.kind === "office")
    return Response.redirect(`${here}/office/${state.officeName}`, 303);
  if (!customerSshKey) {
    if (state.kind !== "continue") return new Response(null, { status: 400 });
    if (officeName !== state.officeName) {
      return new Response(null, { status: 409 });
    }
    const result = await continueSignup(accountId);
    if (!result.ok) {
      if ("officeName" in result)
        return Response.redirect(`${here}/office/${result.officeName}`, 303);
      const back = new URL("/signup", here);
      back.searchParams.set("error", result.reason);
      return Response.redirect(back.toString(), 303);
    }
    return Response.redirect(result.checkoutUrl, 303);
  }
  const plan = field("plan");
  const couponRaw = field("couponId");

  const result = await signUpOffice({
    accountId,
    officeName,
    plan,
    couponId: couponRaw || null,
    customerSshKey: customerSshKey || null,
  });

  if (!result.ok) {
    if (request.headers.get("accept")?.includes("application/json")) {
      return Response.json(result, { status: 400 });
    }
    const back = new URL("/signup", here);
    back.searchParams.set("error", result.reason);
    back.searchParams.set("name", officeName);
    return Response.redirect(back.toString(), 303);
  }
  if (request.headers.get("accept")?.includes("application/json")) {
    return Response.json(result);
  }
  return Response.redirect(result.checkoutUrl, 303);
}
