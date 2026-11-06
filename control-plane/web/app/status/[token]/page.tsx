import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocumentLanguage } from "../../../lib/i18n/document-language";
import { DEFAULT_LANGUAGE } from "../../../lib/i18n/languages";
import { zonedTime } from "../../../lib/incident-time";
import { statusList } from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Private: next.config.ts also sends noindex, no-referrer and no-store for
 * every /status path. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * A customer's critical issues, from its private link. No sign-in: the link is
 * the key (incidents.ts statusToken). English only, like the updates on it.
 * A bad, old or unknown link is the same 404.
 */
export default async function StatusList({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await statusList(token);
  if (!view) notFound();

  return (
    <main>
      <DocumentLanguage language={DEFAULT_LANGUAGE} />
      <h1>Critical issues: {view.customerLabel}</h1>
      <p className="note">
        While an issue is open, we post an update at least every hour. Each
        update also goes by email to your contacts. Keep this link private:
        anyone who has it can read these pages.
      </p>
      {view.incidents.length === 0 ? (
        <p className="note">There are no issues.</p>
      ) : (
        <ul className="card rows">
          {view.incidents.map((incident) => (
            <li key={incident.n}>
              <a href={`/status/${token}/${incident.n}`}>{incident.title}</a>{" "}
              <span data-state={incident.status === "open" ? "active" : "done"}>
                {incident.kind} &middot; {incident.status}
              </span>
              <br />
              <span className="note">
                Opened {zonedTime(incident.openedAt, "UTC")}. Last update{" "}
                {zonedTime(incident.lastUpdateAt, "UTC")}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
