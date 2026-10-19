import {
  handleSignInLinkRequest,
  linkAddressLimiter,
  linkIpLimiter,
} from "../../../../lib/signin-link-request.server";
import { deploymentSignInTokens } from "../../../../lib/signin-link.server";
import { sendSignInMail } from "../../../../lib/signin-mail.server";

export const dynamic = "force-dynamic";

/** Mails a sign-in link. See lib/signin-link-request.server.ts. */
export async function POST(request: Request): Promise<Response> {
  return handleSignInLinkRequest(request, {
    apiKey: process.env.AUTH_RESEND_KEY || undefined,
    tokens: deploymentSignInTokens(),
    ipLimiter: linkIpLimiter,
    addressLimiter: linkAddressLimiter,
    sendMail: sendSignInMail,
  });
}
