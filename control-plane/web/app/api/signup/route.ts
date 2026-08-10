import { auth } from "../../../auth";
import { checkSignupOrigin, signUpOffice } from "../../../lib/services.server";

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
  const trusted = await checkSignupOrigin(request.headers.get("origin"));
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
  const plan = field("plan");
  const couponRaw = field("couponId");

  const result = await signUpOffice({
    accountId,
    officeName,
    plan,
    couponId: couponRaw || null,
  });

  if (!result.ok) {
    const back = new URL("/signup", here);
    back.searchParams.set("error", result.reason);
    back.searchParams.set("name", officeName);
    return Response.redirect(back.toString(), 303);
  }
  return Response.redirect(result.checkoutUrl, 303);
}
