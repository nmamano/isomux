import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { opsInstance } from "../../../lib/services.server";
import { OpsInstance } from "../../../components/ops-instance";

export const dynamic = "force-dynamic";

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

  return <OpsInstance initial={view} />;
}
