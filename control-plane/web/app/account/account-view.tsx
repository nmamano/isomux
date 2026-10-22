"use client";

import { useState } from "react";
import type { SupportedLanguageCode } from "../../lib/i18n/languages";
import { translatorFor, type Translator } from "../../lib/i18n/translate";
import { SIGNIN_LINK_TTL_MS } from "../../lib/signin-link-payload";

/** The account page's body. The routes it posts to are in
 * lib/account-email-request.server.ts. */
export function AccountView({
  language,
  email,
  google,
}: {
  language: SupportedLanguageCode;
  email: string;
  google: boolean;
}) {
  const { t } = translatorFor(language);
  return (
    <main lang={language}>
      <h1>{t("account.heading")}</h1>
      <ChangeEmail t={t} email={email} />
      {google && <GoogleSignIn t={t} email={email} />}
    </main>
  );
}

function ChangeEmail({ t, email }: { t: Translator["t"]; email: string }) {
  const [newEmail, setNewEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    setRefusal(null);
    try {
      const response = await fetch("/api/account/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: newEmail }),
      });
      if (response.status === 401) {
        window.location.assign("/signin");
        return;
      }
      if (response.ok) setSentTo(newEmail.trim());
      // The server words its refusals in the customer's language.
      else setRefusal((await response.text()) || t("signIn.emailFailed"));
    } catch {
      setRefusal(t("signIn.emailFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-narrow">
      <h2>{t("account.email")}</h2>
      <p>
        <span className="address" data-testid="account-email">
          {email}
        </span>
      </p>
      {sentTo !== null ? (
        <p data-testid="email-change-status" role="status">
          {t("account.changeEmailSent", {
            email: sentTo,
            minutes: SIGNIN_LINK_TTL_MS / 60_000,
          })}
        </p>
      ) : (
        <form
          className="form"
          data-testid="email-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            void request();
          }}
        >
          <p>
            <label>
              {t("account.newEmailLabel")}{" "}
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                data-testid="email-change-address"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
            </label>
          </p>
          {refusal && (
            <p className="callout callout-danger" role="alert">
              {refusal}
            </p>
          )}
          <button className="btn-primary" type="submit" disabled={busy}>
            {t("account.changeEmailSubmit")}
          </button>
        </form>
      )}
    </div>
  );
}

function GoogleSignIn({ t, email }: { t: Translator["t"]; email: string }) {
  const [state, setState] = useState<"bound" | "busy" | "removed" | "failed">(
    "bound",
  );

  async function remove() {
    setState("busy");
    try {
      const response = await fetch("/api/account/google/remove", {
        method: "POST",
      });
      if (response.status === 401) {
        window.location.assign("/signin");
        return;
      }
      // 404: nothing was bound any more, which is what was asked for.
      setState(response.ok || response.status === 404 ? "removed" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="card card-narrow">
      <h2>{t("account.googleHeading")}</h2>
      {state === "removed" ? (
        <p data-testid="google-status" role="status">
          {t("account.googleRemoved")}
        </p>
      ) : (
        <>
          <p>{t("account.googleOn")}</p>
          {state === "failed" && (
            <p className="callout callout-danger" role="alert">
              {t("account.googleRemoveFailed")}
            </p>
          )}
          <p className="note">{t("account.googleRemoveNote", { email })}</p>
          <button
            type="button"
            data-testid="google-remove"
            disabled={state === "busy"}
            onClick={() => void remove()}
          >
            {t("account.googleRemove")}
          </button>
        </>
      )}
    </div>
  );
}
