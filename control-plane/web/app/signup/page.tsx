import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { plans, signupPageState } from "../../lib/services.server";
import { OFFICE_DOMAIN } from "../../../signup";
import { SignupForm } from "../../components/signup-form";
import { PolicyNotice } from "../../components/policy-notice";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { languageForRequest } from "../../lib/i18n/request.server";
import { translatorFor } from "../../lib/i18n/translate";

export const dynamic = "force-dynamic";

/**
 * This page renders on the server, so it resolves the language from the request
 * itself - the switch's cookie first, then Accept-Language - and the HTML the
 * customer receives is already translated. `lang` on the <main> marks the
 * translated region for a reader with no JavaScript, because the root layout's
 * attribute is a static "en" it cannot change per request; `DocumentLanguage`
 * moves the root attribute once the page is live.
 */
export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.accountId) redirect("/signin");

  const language = await languageForRequest();
  const { t } = translatorFor(language);

  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const name = typeof params.name === "string" ? params.name : "";
  const settingUpAnother = params.another === "1";
  const [options, state] = await Promise.all([
    plans(),
    signupPageState(session.accountId),
  ]);
  if (state.kind === "paid" && !settingUpAnother) redirect("/");
  return (
    <main lang={language}>
      <DocumentLanguage language={language} />
      <p className="back-link">
        <Link href="/">&larr; {t("common.backToOffices")}</Link>
      </p>
      <h1>{t("signup.heading")}</h1>
      {error && state.kind === "continue" && (
        <p
          className="callout callout-danger"
          data-testid="signup-error"
          role="alert"
        >
          {error}
        </p>
      )}
      {state.kind === "continue" && !settingUpAnother ? (
        <form className="form card" method="post" action="/api/signup">
          <input type="hidden" name="signupIntent" value="continue" />
          <input type="hidden" name="officeName" value={state.officeName} />
          <PolicyNotice language={language} />
          <button
            className="btn-primary"
            type="submit"
            data-testid="signup-submit"
          >
            {t("signup.continue")}
          </button>
        </form>
      ) : (
        <SignupForm
          language={language}
          initialName={name}
          initialError={error}
          domain={OFFICE_DOMAIN}
          plans={options}
        />
      )}
    </main>
  );
}
