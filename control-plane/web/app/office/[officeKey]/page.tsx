import { notFound, redirect } from "next/navigation";
import { auth } from "../../../auth";
import { officeRouteForAccount } from "../../../lib/services.server";
import { OfficeView } from "../../../components/office-view";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Office({
  params,
}: {
  params: Promise<{ officeKey: string }>;
}) {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const { officeKey } = await params;
  const view = await officeRouteForAccount(accountId, officeKey);
  // Not yours and not there look the same from out here.
  if (!view) notFound();

  return (
    <>
      <nav className="page-back" aria-label="Office navigation">
        <Link href="/">&larr; Your offices</Link>
      </nav>
      <OfficeView initial={view} instanceId={view.instanceId} />
    </>
  );
}
