import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { OpsIncidents } from "../../../components/ops-incidents";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { OPS_LANGUAGE } from "../../../lib/i18n/request.server";
import { opsIncidentsFor } from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * The operator's page for critical issues: open one, post its hourly updates,
 * resolve it, re-make a customer's link, rotate the write key. English, like
 * the rest of the ops floor. A non-operator gets the same 404 as /ops.
 */
export default async function OpsIncidentsPage() {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const view = await opsIncidentsFor(accountId);
  if (!view) notFound();

  return (
    <>
      <DocumentLanguage language={OPS_LANGUAGE} />
      <OpsIncidents initial={view} />
    </>
  );
}
