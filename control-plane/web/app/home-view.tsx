"use client";

import Link from "next/link";
import { useSessionProbe } from "../lib/use-session";
import type { OfficeCard } from "../lib/session-view";
import { DocumentLanguage } from "../lib/i18n/document-language";
import { useLanguage } from "../lib/i18n/use-language";
import { webTranslatorFor, type WebTranslator } from "../lib/i18n/rich";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { customerPriceLine } from "../components/plan-copy";

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
        <Dashboard i18n={i18n} offices={probe.offices ?? []} />
      ) : (
        <SignedOut i18n={i18n} />
      )}
    </>
  );
}

/** The product site's front page in each storefront language. */
export const WHAT_IS_ISOMUX_URL: Record<SupportedLanguageCode, string> = {
  en: "https://isomux.com/",
  es: "https://isomux.com/es/",
  ca: "https://isomux.com/ca/",
  zh: "https://isomux.com/zh/",
};

/** The shell a CDN holds: the hosted landing's hero, with its art as a still.
 * Exported so its test can render it on a language without running an
 * effect. */
export function SignedOut({ i18n }: { i18n: WebTranslator }) {
  return (
    <main className="hero">
      <h1>Hosted Isomux</h1>
      <p className="hero-tagline">
        {i18n.rich("home.tagline", {
          address: (chunk) => <span className="address">{chunk}</span>,
        })}
      </p>
      {/* A still of the landing's live office, in the landing's light or dark
          theme as the visitor's system asks. Decorative: the sentence above
          says what it shows. The size attributes reserve its box before it
          loads. */}
      <picture>
        <source
          srcSet="/office-light.webp"
          media="(prefers-color-scheme: light)"
        />
        <img
          className="hero-art"
          src="/office.webp"
          alt=""
          width={820}
          height={616}
        />
      </picture>
      <p className="hero-actions">
        <a className="btn" href={WHAT_IS_ISOMUX_URL[i18n.language]}>
          {i18n.t("home.whatIsIsomux")}
        </a>
        <Link className="btn btn-primary" href="/signin">
          {i18n.t("signIn.heading")}
        </Link>
      </p>
    </main>
  );
}

export function Dashboard({
  i18n,
  offices,
}: {
  i18n: WebTranslator;
  offices: OfficeCard[];
}) {
  return (
    <main data-testid="dashboard">
      <div className="page-head">
        {/* The English splits at MORE THAN ONE, which is not where
            Intl.PluralRules splits: an account with no office reads "Your
            office" today, and a plural pair picked by tn() would move it to
            "Your offices". Two keys chosen by the page's own test keep every
            language on the same branch. The plural one is
            `common.backToOffices`: this heading and the back link on the inner
            pages are the same string, so it lives under common.* (ruling 15). */}
        <h1>
          {offices.length > 1
            ? i18n.t("common.backToOffices")
            : i18n.t("home.officeHeading")}
        </h1>
        {offices.length > 0 && (
          <Link className="btn btn-primary btn-add" href="/signup?another=1">
            {i18n.t("home.setUpAnother")}
          </Link>
        )}
      </div>
      {offices.length > 0 ? (
        <div className="office-grid">
          {offices.map((office) => (
            <OfficeCardLink
              key={office.instanceId}
              i18n={i18n}
              office={office}
            />
          ))}
        </div>
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

/** One office: the whole card is the link. A deleted office shows no price,
 * because nothing is charged for it. */
function OfficeCardLink({
  i18n,
  office,
}: {
  i18n: WebTranslator;
  office: OfficeCard;
}) {
  const price = office.ended
    ? null
    : customerPriceLine(
        i18n.language,
        office.plan.customerPrice,
        office.plan.currency,
      );
  return (
    <Link
      className="card office-card"
      href={`/office/${office.officeName}`}
      data-ended={office.ended ? "" : undefined}
    >
      <span className="office-card-head">
        <span className="address">{office.hostname}</span>
        {/* The same chip the provisioning ladder uses, so "ready" reads the
            same here as it does inside the office. An ended office gets the
            plain chip. */}
        <span
          data-state={office.ended ? "ended" : office.ready ? "done" : "active"}
        >
          {office.ended
            ? i18n.t("home.ended")
            : office.ready
              ? i18n.t("home.ready")
              : i18n.t("home.notReady")}
        </span>
      </span>
      {/* The plan name and its figures are the product's own words (ruling 11). */}
      <span className="office-card-plan note">
        <span>{office.plan.label}</span>
        {office.plan.specification && <span>{office.plan.specification}</span>}
      </span>
      <span className="office-card-foot">
        <span className="note">{price}</span>
        <span className="office-card-action">
          {i18n.t("home.viewOffice")} &rarr;
        </span>
      </span>
    </Link>
  );
}
