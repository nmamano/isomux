import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../auth";
import { opsFloor } from "../../lib/services.server";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { OPS_LANGUAGE } from "../../lib/i18n/request.server";

export const dynamic = "force-dynamic";

/**
 * OPS IS ENGLISH, and says so rather than inheriting it. The operator floor is
 * not a customer surface (S11 scope), so it renders no language switch and no
 * catalog text; `DocumentLanguage` is here to put the root `lang` BACK to
 * English after a client navigation from a translated page, which is the one
 * way this page could end up described as Spanish.
 */

/**
 * The alerting floor the design asks for before we charge anyone, as a page
 * rather than a pager.
 *
 * The authority check is not here. `opsFloor` re-reads the account and its
 * operator flag inside the service, so this page cannot be the thing that
 * decides - it only renders what it was given, and null means 404. A 403 would
 * confirm the floor exists and that this account is not on it.
 */
export default async function Ops() {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) redirect("/signin");

  const floor = await opsFloor(accountId);
  if (!floor) notFound();

  return (
    <main className="wide">
      <DocumentLanguage language={OPS_LANGUAGE} />
      <h1>Ops floor</h1>

      <h2>Attention</h2>
      {floor.attention.length === 0 ? (
        <p className="note" data-testid="ops-attention-empty">
          Nothing is raised.
        </p>
      ) : (
        <ul className="card rows" data-testid="ops-attention">
          {floor.attention.map((item) => (
            <li key={item.reasonId} data-severity={item.severity}>
              <Link href={`/ops/${item.instanceId}`}>{item.officeName}</Link> -{" "}
              <strong>{item.severity}</strong> - {item.reasonClass} -{" "}
              {item.reason} - open {hours(item.ageMs)}
              {item.acknowledgedAt
                ? ` (we have seen it: ${item.acknowledgedBy})`
                : ""}
            </li>
          ))}
        </ul>
      )}

      <h2>Past their deadline</h2>
      {floor.overdue.length === 0 ? (
        <p className="note" data-testid="ops-overdue-empty">
          Nothing is overdue.
        </p>
      ) : (
        <ul className="card rows" data-testid="ops-overdue">
          {floor.overdue.map((op) => (
            <li key={op.operationId}>
              <Link href={`/ops/${op.instanceId}`}>{op.officeName}</Link> -{" "}
              {op.kind} - {op.status} - attempt {op.attempt} - overdue by{" "}
              {hours(op.overdueMs)}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Age in the units an operator actually reads it in. */
function hours(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return h < 48 ? `${h}h ${minutes % 60}m` : `${Math.floor(h / 24)}d`;
}
