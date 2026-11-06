import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AGREEMENT, MAX_SEATS } from "../../../enterprise";
import { auth } from "../../auth";
import {
  EnterpriseAccount,
  EnterpriseSetup,
} from "../../components/enterprise-view";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { languageForRequest } from "../../lib/i18n/request.server";
import {
  accountSettings,
  enterpriseAccountFor,
} from "../../lib/services.server";

export const dynamic = "force-dynamic";

/** Private: next.config.ts also sends noindex, no-referrer and no-store for
 * every /enterprise path, because the page shows the account's secret. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * A company's enterprise account (control-plane/enterprise.ts): the set-up
 * form when the signed-in account has none, the agreement until a standard
 * account is signed, then the one account page.
 */
export default async function Enterprise() {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");
  const { view, now } = await enterpriseAccountFor(accountId);
  const language = await languageForRequest();
  if (!view) {
    const settings = await accountSettings(accountId);
    if (!settings) redirect("/signin");
    return (
      <>
        <DocumentLanguage language={language} />
        <EnterpriseSetup
          language={language}
          email={settings.email}
          maxSeats={MAX_SEATS}
        />
      </>
    );
  }
  if (view.kind === "standard" && !view.signature)
    redirect("/enterprise/agreement");
  return (
    <>
      <DocumentLanguage language={language} />
      <EnterpriseAccount
        language={language}
        view={view}
        now={now}
        pdfPath={AGREEMENT.publicPath}
        maxSeats={MAX_SEATS}
      />
    </>
  );
}
