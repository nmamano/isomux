"use client";

import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { useLanguage } from "../../lib/i18n/use-language";
import { translatorFor, type Translator } from "../../lib/i18n/translate";
import { SIGNIN_LINK_TTL_MS } from "../../lib/signin-link-payload";
import { RATE_LIMITED_MARKER } from "../../lib/rate-limit-marker";

const EMAIL_LINK_PROVIDER = "email-link";
/** The error Auth.js puts on the sign-in page when a Credentials sign-in is
 * refused: here, a link already used or expired. */
const LINK_FAILED_ERROR = "CredentialsSignin";

/**
 * The sign-in controls. Split out of `page.tsx` so that the page itself can be
 * a server component and ask whether the visitor is already signed in - a
 * question a client component rendered from the prerender cache cannot answer.
 *
 * BOTH PROVIDERS NAME THEIR RETURN TARGET. `signIn(provider)` with no
 * `callbackUrl` defaults to the page the flow started on, which here is
 * `/signin` - so a completely successful sign-in returned the visitor to the
 * sign-in page, which offered to sign them in again. Measured 2026-08-11 on the
 * first real Google sign-in: the account bound, no error was raised, and the
 * loop looked exactly like a failure. The dev provider already passed `"/"`;
 * that asymmetry is why no earlier transcript caught it.
 *
 * The email-link form is rendered only when GET /api/auth/providers lists
 * "email-link", which the server does only once its mail key is set: the page
 * is prerendered and deploys from main, so before then it must look exactly as
 * it did without the feature. A link that failed (used or expired) comes back
 * here as Auth.js's CredentialsSignin error.
 *
 * The dev provider's form is rendered only when the server put it in the
 * providers list; `NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH` mirrors that flag for the
 * browser half. Google gets a plain button, and pressing it when no client is
 * configured is a 404 from Auth.js rather than a half-working form. THE DEV FORM
 * IS NOT TRANSLATED: it is a developer tool behind a build flag, not something a
 * customer reads.
 *
 * This page is prerendered too, so its language is resolved in the browser and
 * the first paint is English. See `home-view.tsx` for why.
 */
export function SignInForm() {
  const [email, setEmail] = useState("");
  const devAuth = process.env.NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH === "1";
  const language = useLanguage();
  const { t } = translatorFor(language);
  // A sign-in refused by the per-address quota lands here with a marker. The
  // query is the external system: the page is prerendered and cannot see it.
  const [rateLimited, setRateLimited] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRateLimited(error === RATE_LIMITED_MARKER);
    setLinkFailed(error === LINK_FAILED_ERROR);
  }, []);
  const [emailLink, setEmailLink] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : {}))
      .then((listed: unknown) => {
        if (live && typeof listed === "object" && listed !== null) {
          setEmailLink(EMAIL_LINK_PROVIDER in listed);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <main>
      <DocumentLanguage language={language} />
      <h1>{t("signIn.heading")}</h1>
      {rateLimited && (
        <p
          className="callout callout-danger"
          data-testid="signin-error"
          role="alert"
        >
          {t("errors.rateLimited")}
        </p>
      )}
      {linkFailed && (
        <p className="callout callout-danger" role="alert">
          {t("signIn.linkFailed")}
        </p>
      )}
      {emailLink && <EmailLinkRequest t={t} />}
      <div className="card card-narrow">
        <button
          className="btn-primary"
          type="button"
          onClick={() => void signIn("google", { callbackUrl: "/" })}
        >
          {t("signIn.google")}
        </button>
      </div>
      {devAuth && (
        <form
          className="form card card-narrow"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn("dev", { email, callbackUrl: "/" });
          }}
        >
          <h2>Developer sign-in</h2>
          <p>
            <label>
              Email{" "}
              <input
                name="email"
                type="email"
                data-testid="dev-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          </p>
          <button
            className="btn-primary"
            type="submit"
            data-testid="dev-submit"
          >
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}

/** The address field, and then the sentence that says where the link went. */
function EmailLinkRequest({ t }: { t: Translator["t"] }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    setRefusal(null);
    try {
      const response = await fetch("/api/signin/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (response.ok) setSentTo(email.trim());
      // The server words its refusals in the visitor's language.
      else setRefusal((await response.text()) || t("signIn.emailFailed"));
    } catch {
      setRefusal(t("signIn.emailFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo !== null) {
    return (
      <div className="card card-narrow">
        <p data-testid="email-link-status" role="status">
          {t("signIn.emailSent", {
            email: sentTo,
            minutes: SIGNIN_LINK_TTL_MS / 60_000,
          })}
        </p>
      </div>
    );
  }
  return (
    <form
      className="form card card-narrow"
      data-testid="email-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        void request();
      }}
    >
      <p>
        <label>
          {t("signIn.emailLabel")}{" "}
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            data-testid="email-link-address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
      </p>
      <button className="btn-primary" type="submit" disabled={busy}>
        {t("signIn.emailSubmit")}
      </button>
      {refusal && (
        <p
          className="callout callout-danger"
          data-testid="email-link-status"
          role="alert"
        >
          {refusal}
        </p>
      )}
    </form>
  );
}
