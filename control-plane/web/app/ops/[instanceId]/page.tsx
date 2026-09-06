import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { opsInstance } from "../../../lib/services.server";
import { OpsInstance } from "../../../components/ops-instance";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { OPS_LANGUAGE } from "../../../lib/i18n/request.server";

export const dynamic = "force-dynamic";

/**
 * OPS IS ENGLISH, and says so rather than inheriting it. The operator floor is
 * not a customer surface (S11 scope), so it renders no language switch and no
 * catalog text; `DocumentLanguage` is here to put the root `lang` BACK to
 * English after a client navigation from a translated page, which is the one
 * way this page could end up described as Spanish.
 */

export default async function OpsOffice({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const { instanceId } = await params;
  const view = await opsInstance(accountId, instanceId);
  // Not an operator and no such office look the same from out here.
  if (!view) notFound();

  return (
    <>
      <DocumentLanguage language={OPS_LANGUAGE} />
      <OpsInstance initial={view} />
    </>
  );
}
