import {
  confirmIpLimiter,
  handleEmailChangeConfirm,
} from "../../../../../lib/account-email-request.server";
import {
  changeAccountEmailFor,
  emailChangeRefusalFor,
  stripeCustomersFor,
  updateStripeCustomerEmail,
} from "../../../../../lib/services.server";
import { deploymentEmailChangeTokens } from "../../../../../lib/signin-link.server";
import { sendEmailChangedNotice } from "../../../../../lib/signin-mail.server";

export const dynamic = "force-dynamic";

/** Applies the change an email change link names. See
 * lib/account-email-request.server.ts. */
export async function POST(request: Request): Promise<Response> {
  return handleEmailChangeConfirm(request, {
    apiKey: process.env.AUTH_RESEND_KEY || undefined,
    tokens: deploymentEmailChangeTokens(),
    ipLimiter: confirmIpLimiter,
    refusal: emailChangeRefusalFor,
    stripeCustomers: stripeCustomersFor,
    updateStripeEmail: updateStripeCustomerEmail,
    change: changeAccountEmailFor,
    sendNotice: sendEmailChangedNotice,
  });
}
