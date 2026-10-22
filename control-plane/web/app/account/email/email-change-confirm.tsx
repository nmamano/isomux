"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { webTranslatorFor } from "../../../lib/i18n/rich";
import { useLanguage } from "../../../lib/i18n/use-language";
import { addressInSignInToken } from "../../../lib/signin-link-payload";

type LinkState =
  | { state: "reading" }
  | { state: "none" }
  | { state: "found"; token: string; email: string };

type Outcome =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "done"; email: string }
  | { state: "link-failed" }
  | { state: "refused"; text: string };

/**
 * The page an email change link opens: one button, never an auto-submit, for
 * the reason app/signin/email/email-link-form.tsx gives (mail scanners open
 * links first). It needs no session: the token names the account and the new
 * address, and the server checks its signature.
 */
export function EmailChangeConfirm() {
  const language = useLanguage();
  const i18n = webTranslatorFor(language);
  const [link, setLink] = useState<LinkState>({ state: "reading" });
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  useEffect(() => {
    const token =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    // The change link carries the address the same way a sign-in link does.
    const email = token ? addressInSignInToken(token) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLink(email ? { state: "found", token, email } : { state: "none" });
  }, []);

  async function confirm(token: string) {
    setOutcome({ state: "busy" });
    try {
      const response = await fetch("/api/account/email/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        const { email } = (await response.json()) as { email: string };
        setOutcome({ state: "done", email });
      } else if (response.status === 400 || response.status === 404) {
        setOutcome({ state: "link-failed" });
      } else {
        // The server words its refusals in the customer's language.
        setOutcome({
          state: "refused",
          text: (await response.text()) || i18n.t("account.confirmFailed"),
        });
      }
    } catch {
      setOutcome({ state: "refused", text: i18n.t("account.confirmFailed") });
    }
  }

  const askAgain = (chunk: React.ReactNode) => (
    <Link href="/account">{chunk}</Link>
  );
  return (
    <main>
      <DocumentLanguage language={language} />
      <h1>{i18n.t("account.confirmHeading")}</h1>
      {link.state === "none" && (
        <p className="callout callout-danger" role="alert">
          {i18n.rich("account.linkInvalid", { account: askAgain })}
        </p>
      )}
      {outcome.state === "link-failed" && (
        <p className="callout callout-danger" role="alert">
          {i18n.rich("account.linkFailed", { account: askAgain })}
        </p>
      )}
      {outcome.state === "refused" && (
        <p className="callout callout-danger" role="alert">
          {outcome.text}
        </p>
      )}
      {outcome.state === "done" ? (
        <div className="card card-narrow">
          <p data-testid="email-change-done" role="status">
            {i18n.t("account.confirmDone", { email: outcome.email })}
          </p>
          <p>
            <Link href="/">{i18n.t("common.backToOffices")}</Link>
          </p>
        </div>
      ) : (
        link.state === "found" &&
        outcome.state !== "link-failed" && (
          <div className="card card-narrow">
            <button
              className="btn-primary"
              type="button"
              data-testid="email-change-confirm"
              disabled={outcome.state === "busy"}
              onClick={() => void confirm(link.token)}
            >
              {i18n.t("account.confirmButton", { email: link.email })}
            </button>
          </div>
        )
      )}
    </main>
  );
}
