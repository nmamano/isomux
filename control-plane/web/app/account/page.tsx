import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { accountSettings } from "../../lib/services.server";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { languageForRequest } from "../../lib/i18n/request.server";
import { translatorFor } from "../../lib/i18n/translate";
import { AccountView } from "./account-view";

export const dynamic = "force-dynamic";

/**
 * The account page: the account's address, the email change, and the Google
 * sign-in when one is bound. Server-rendered like the office page, so the
 * address is the account row's and not the session's.
 */
export default async function Account() {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");
  const settings = await accountSettings(accountId);
  if (!settings) redirect("/signin");

  const language = await languageForRequest();
  const { t } = translatorFor(language);
  return (
    <>
      <DocumentLanguage language={language} />
      <nav
        className="page-back"
        lang={language}
        aria-label={t("office.navLabel")}
      >
        <Link href="/">&larr; {t("common.backToOffices")}</Link>
      </nav>
      <AccountView
        language={language}
        email={settings.email}
        google={settings.google}
      />
    </>
  );
}
