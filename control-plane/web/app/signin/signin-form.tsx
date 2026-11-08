"use client";

import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { useLanguage } from "../../lib/i18n/use-language";
import { translatorFor, type Translator } from "../../lib/i18n/translate";
import { SIGNIN_LINK_TTL_MS } from "../../lib/signin-link-payload";
import { RATE_LIMITED_MARKER } from "../../lib/rate-limit-marker";
import { GOOGLE_REMOVED_MARKER } from "../../lib/google-removed-marker";
import { PolicyLinks } from "../../components/policy-notice";
import {
  SIGNIN_PRODUCTS,
  recordSignInStart,
  startedSignInProduct,
  type SignInProduct,
} from "../../lib/signin-product";

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
 * `product` picks the page: Hosted's /signin or the enterprise one
 * (app/enterprise/signin). Each returns to its own home after sign-in, and
 * the enterprise one names its product and shows nothing of Hosted.
 *
 * This page is prerendered too, so its language is resolved in the browser and
 * the first paint is English. See `home-view.tsx` for why.
 */
export function SignInForm({
  product = "hosted",
}: {
  product?: SignInProduct;
}) {
  const home = SIGNIN_PRODUCTS[product].home;
  const [email, setEmail] = useState("");
  const devAuth = process.env.NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH === "1";
  const language = useLanguage();
  const { t } = translatorFor(language);
  // A sign-in refused by the per-address quota lands here with a marker. The
  // query is the external system: the page is prerendered and cannot see it.
  const [rateLimited, setRateLimited] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const [googleRefused, setGoogleRefused] = useState(false);
  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRateLimited(error === RATE_LIMITED_MARKER);
    setLinkFailed(error === LINK_FAILED_ERROR);
    setGoogleRefused(error === GOOGLE_REMOVED_MARKER);
    // Auth.js sends every failed sign-in here. One this tab started on the
    // enterprise page goes on to that page, with the same query.
    if (
      product === "hosted" &&
      error !== null &&
      startedSignInProduct() === "enterprise"
    ) {
      window.location.replace(
        `${SIGNIN_PRODUCTS.enterprise.signInPath}${window.location.search}`,
      );
    }
  }, [product]);
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
    <main className="auth-page">
      <DocumentLanguage language={language} />
      <div className="auth-card">
        <span className="brand-mark" />
        <h1>{t("signIn.heading")}</h1>
        {product === "enterprise" ? (
          <>
            <p className="auth-sub">{t("signIn.enterpriseSubheading")}</p>
            <ol className="auth-steps" data-testid="enterprise-steps">
              <li>{t("signIn.enterpriseStepSignIn")}</li>
              <li>{t("signIn.enterpriseStepAgreement")}</li>
              <li>{t("signIn.enterpriseStepOffices")}</li>
            </ol>
          </>
        ) : (
          <p className="auth-sub">{t("signIn.subheading")}</p>
        )}
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
        {googleRefused && (
          <p className="callout callout-danger" role="alert">
            {t("signIn.googleAccountRefused")}
          </p>
        )}
        {emailLink && (
          <>
            <EmailLinkRequest t={t} product={product} />
            <p className="auth-or" data-testid="signin-or">
              {t("signIn.or")}
            </p>
          </>
        )}
        <button
          className="btn-block"
          type="button"
          data-testid="signin-google"
          onClick={() => {
            recordSignInStart(product);
            void signIn("google", { callbackUrl: home });
          }}
        >
          <GoogleLogo />
          {t("signIn.google")}
        </button>
      </div>
      {devAuth && (
        <form
          className="form auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            recordSignInStart(product);
            void signIn("dev", { email, callbackUrl: home });
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
      <PolicyLinks product={product} />
    </main>
  );
}

/** Google's own mark, as its sign-in guidelines draw it beside the label. */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

/** The address field, and then the sentence that says where the link went. */
function EmailLinkRequest({
  t,
  product,
}: {
  t: Translator["t"];
  product: SignInProduct;
}) {
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
        // Hosted's body stays the address alone.
        body: JSON.stringify(
          product === "hosted" ? { email } : { email, product },
        ),
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
      <div className="auth-sent">
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
      className="form"
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
      <button className="btn-primary btn-block" type="submit" disabled={busy}>
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
