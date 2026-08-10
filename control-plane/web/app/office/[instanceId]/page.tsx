import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { progressForAccount } from "../../../lib/services.server";
import { OfficeView } from "../../../components/office-view";

export const dynamic = "force-dynamic";

export default async function Office({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const { instanceId } = await params;
  const view = await progressForAccount(accountId, instanceId);
  // Not yours and not there look the same from out here.
  if (!view) notFound();

  return <OfficeView initial={view} instanceId={instanceId} />;
}
