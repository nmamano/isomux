import type { Metadata } from "next";
import { ENTERPRISE_TITLE } from "../../../lib/signin-product";
import { SignedInRedirect } from "../../signin/signed-in-redirect";
import { SignInForm } from "../../signin/signin-form";

/** The enterprise sign-in page: the Hosted sign-in page's prerendered shell
 * and guard (app/signin/page.tsx), for Isomux for Enterprise. */
export const dynamic = "error";

export const metadata: Metadata = { title: ENTERPRISE_TITLE };

export default function EnterpriseSignIn() {
  return (
    <>
      <SignedInRedirect product="enterprise" />
      <SignInForm product="enterprise" />
    </>
  );
}
