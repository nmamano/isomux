"use client";

import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { useLanguage } from "../../lib/i18n/use-language";
import { translatorFor } from "../../lib/i18n/translate";
import { RATE_LIMITED_MARKER } from "../../lib/rate-limit-marker";

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
  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRateLimited(error === RATE_LIMITED_MARKER);
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
          <label>
            Email{" "}
            <input
              name="email"
              type="email"
              data-testid="dev-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>{" "}
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
