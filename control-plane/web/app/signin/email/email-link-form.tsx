"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { webTranslatorFor } from "../../../lib/i18n/rich";
import { useLanguage } from "../../../lib/i18n/use-language";
import { addressInSignInToken } from "../../../lib/signin-link-payload";

type LinkState =
  | { state: "reading" }
  | { state: "none" }
  | { state: "found"; token: string; email: string };

/**
 * The page an emailed sign-in link opens: one button, never an auto-submit.
 *
 * Mail scanners open links before the person does, and a page that signed in
 * by itself would spend the single-use token on the scanner's visit. The token
 * is in the fragment, which only this script reads; the address shown is read
 * out of it for display, and the server checks the signature when the button
 * posts it.
 */
export function EmailLinkForm() {
  const language = useLanguage();
  const i18n = webTranslatorFor(language);
  const [link, setLink] = useState<LinkState>({ state: "reading" });
  useEffect(() => {
    const token =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    const email = token ? addressInSignInToken(token) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLink(email ? { state: "found", token, email } : { state: "none" });
  }, []);

  return (
    <main>
      <DocumentLanguage language={language} />
      <h1>{i18n.t("signIn.linkHeading")}</h1>
      {link.state === "none" && (
        <p className="callout callout-danger" role="alert">
          {i18n.rich("signIn.linkInvalid", {
            signin: (chunk) => <Link href="/signin">{chunk}</Link>,
          })}
        </p>
      )}
      {link.state === "found" && (
        <div className="card card-narrow">
          <button
            className="btn-primary"
            type="button"
            data-testid="email-link-signin"
            onClick={() =>
              void signIn("email-link", { token: link.token, callbackUrl: "/" })
            }
          >
            {i18n.t("signIn.linkSignInAs", { email: link.email })}
          </button>
        </div>
      )}
    </main>
  );
}
