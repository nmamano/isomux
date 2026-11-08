import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AGREEMENT } from "../../../../enterprise";
import { auth } from "../../../auth";
import { ENTERPRISE_TITLE } from "../../../lib/signin-product";
import { EnterpriseAgreement } from "../../../components/enterprise-view";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { languageForRequest } from "../../../lib/i18n/request.server";
import { enterpriseAccountFor } from "../../../lib/services.server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: ENTERPRISE_TITLE,
  robots: { index: false, follow: false },
};

/** The standard agreement for a standard account not signed yet. Every other
 * case goes to /enterprise, which sends it on. */
export default async function EnterpriseAgreementPage() {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/enterprise/signin");
  const { view, now } = await enterpriseAccountFor(accountId);
  if (!view || view.kind !== "standard" || view.signature)
    redirect("/enterprise");
  const language = await languageForRequest();
  return (
    <>
      <DocumentLanguage language={language} />
      <EnterpriseAgreement
        language={language}
        company={view.company}
        now={now}
        pdfPath={AGREEMENT.publicPath}
      />
    </>
  );
}
