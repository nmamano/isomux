"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { useSessionProbe } from "../lib/use-session";
import type { OfficeCard } from "../lib/session-view";
import { DocumentLanguage } from "../lib/i18n/document-language";
import { useLanguage } from "../lib/i18n/use-language";
import { webTranslatorFor, type WebTranslator } from "../lib/i18n/rich";

/**
 * The landing page's body, on the client, so that `page.tsx` can be prerendered.
 *
 * WHAT PAINTS FIRST IS THE SIGNED-OUT PAGE, and that is deliberate rather than a
 * placeholder: it is the marketing shell a CDN can hold, and it has to carry the
 * real copy and the real link or there is nothing worth caching. A signed-in
 * visitor therefore reads it for the length of one same-origin fetch before the
 * dashboard replaces it. That flash is the price of the page being cacheable at
 * all; cookie-varying HTML cannot be held by a shared cache under any flag.
 *
 * IT ALSO PAINTS FIRST IN ENGLISH, for the same reason: the prerendered bytes
 * are English, so `useLanguage` returns English on the first render and moves to
 * the visitor's language after hydration. `DocumentLanguage` moves the root
 * `lang` in the same commit, so the attribute never describes text that is no
 * longer there.
 *
 * `loading` and `unavailable` draw the same shell, because neither knows the
 * visitor is signed in. The hook keeps asking; see `lib/use-session.ts`.
 */
export function HomeView() {
  const probe = useSessionProbe({ offices: true });
  const language = useLanguage();
  const i18n = webTranslatorFor(language);
  return (
    <>
      <DocumentLanguage language={language} />
      {probe.state === "signed-in" ? (
        <Dashboard
          i18n={i18n}
          email={probe.email}
          offices={probe.offices ?? []}
        />
      ) : (
        <SignedOut i18n={i18n} />
      )}
    </>
  );
}

/** The shell a CDN holds. Exported so its test can render it on a language
 * without running an effect (ruling 14: the test asserts literal text). */
export function SignedOut({ i18n }: { i18n: WebTranslator }) {
  return (
    <main>
      <h1>Hosted Isomux</h1>
      <p className="lead">
        {i18n.rich("home.signedOutLead", {
          signin: (chunk) => <Link href="/signin">{chunk}</Link>,
        })}
      </p>
    </main>
  );
}

export function Dashboard({
  i18n,
  email,
  offices,
}: {
  i18n: WebTranslator;
  email: string | null;
  offices: OfficeCard[];
}) {
  return (
    <main>
      <div className="account-line">
        <p className="note" data-testid="signed-in-as">
          {i18n.t("home.signedInAs", { email: email ?? "" })}
        </p>
        {/* Still a form around the button, so the flex row and the click target
            are the ones the page has always had. What changed is who handles the
            submit: a server action cannot live in a client component, so this
            calls Auth.js from the browser. `redirectTo` is the option this
            version of next-auth declares; `callbackUrl` is deprecated. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" data-testid="sign-out">
            {i18n.t("common.signOut")}
          </button>
        </form>
      </div>
      {/* The English splits at MORE THAN ONE, which is not where Intl.PluralRules
          splits: an account with no office reads "Your office" today, and a
          plural pair picked by tn() would move it to "Your offices". Two keys
          chosen by the page's own test keep every language on the same branch.
          The plural one is `common.backToOffices`: this heading and the back
          link on the inner pages are the same string, so it lives under
          common.* (ruling 15). */}
      <h1>
        {offices.length > 1
          ? i18n.t("common.backToOffices")
          : i18n.t("home.officeHeading")}
      </h1>
      {offices.length > 0 ? (
        <>
          {offices.map((office) => (
            <Link
              className="card office-card-link"
              href={`/office/${office.officeName}`}
              key={office.instanceId}
            >
              <p className="lead">
                <span className="address">{office.hostname}</span> -{" "}
                {/* The same chip the provisioning ladder uses, so "ready" reads
                    the same here as it does inside the office. */}
                <span data-state={office.ready ? "done" : "active"}>
                  {office.ready ? i18n.t("home.ready") : i18n.t("home.notReady")}
                </span>
              </p>
              <span className="office-card-action">
                {i18n.t("home.viewOffice")} &rarr;
              </span>
            </Link>
          ))}
          <p>
            {i18n.rich("home.setUpAnother", {
              link: (chunk) => <Link href="/signup?another=1">{chunk}</Link>,
            })}
          </p>
        </>
      ) : (
        <div className="card">
          <p>
            {i18n.rich("home.noOffice", {
              link: (chunk) => <Link href="/signup">{chunk}</Link>,
            })}
          </p>
        </div>
      )}
    </main>
  );
}
