import { auth } from "../../../../auth";
import {
  changeAccountLimiter,
  changeAddressLimiter,
  changeIpLimiter,
  handleEmailChangeRequest,
} from "../../../../lib/account-email-request.server";
import { emailChangeRefusalFor } from "../../../../lib/services.server";
import { deploymentEmailChangeTokens } from "../../../../lib/signin-link.server";
import { sendEmailChangeMail } from "../../../../lib/signin-mail.server";

export const dynamic = "force-dynamic";

/** Mails an email change link. See lib/account-email-request.server.ts. */
export async function POST(request: Request): Promise<Response> {
  return handleEmailChangeRequest(request, {
    apiKey: process.env.AUTH_RESEND_KEY || undefined,
    tokens: deploymentEmailChangeTokens(),
    accountId: async () => (await auth())?.accountId ?? null,
    ipLimiter: changeIpLimiter,
    accountLimiter: changeAccountLimiter,
    addressLimiter: changeAddressLimiter,
    refusal: emailChangeRefusalFor,
    sendMail: sendEmailChangeMail,
  });
}
