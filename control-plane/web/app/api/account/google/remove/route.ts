import { auth, keepSession } from "../../../../../auth";
import { handleGoogleRemoval } from "../../../../../lib/account-email-request.server";
import { removeGoogleSignInFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Unbinds the account's Google sign-in. See
 * lib/account-email-request.server.ts. */
export async function POST(request: Request): Promise<Response> {
  return handleGoogleRemoval(request, {
    accountId: async () => (await auth())?.accountId ?? null,
    remove: removeGoogleSignInFor,
    keepSession,
  });
}
