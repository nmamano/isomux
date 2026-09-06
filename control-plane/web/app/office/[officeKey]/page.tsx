import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { officeRouteForAccount } from "../../../lib/services.server";
import { OfficeView } from "../../../components/office-view";
import Link from "next/link";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { languageForRequest } from "../../../lib/i18n/request.server";
import { translatorFor } from "../../../lib/i18n/translate";

export const dynamic = "force-dynamic";

/**
 * Server-rendered, so the language comes from the request (the switch's cookie
 * first, then Accept-Language) and the customer receives translated HTML. The
 * `lang` attributes here and on the view's own <main> mark the translated
 * regions for a reader with no JavaScript; `DocumentLanguage` moves the root
 * attribute once the page is live. See `app/layout.tsx` for why the root cannot
 * carry it directly.
 */
export default async function Office({
  params,
}: {
  params: Promise<{ officeKey: string }>;
}) {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const language = await languageForRequest();
  const { t } = translatorFor(language);
  const { officeKey } = await params;
  const view = await officeRouteForAccount(accountId, officeKey);
  // Not yours and not there look the same from out here.
  if (!view) notFound();

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
      <OfficeView
        language={language}
        initial={view}
        instanceId={view.instanceId}
      />
    </>
  );
}
