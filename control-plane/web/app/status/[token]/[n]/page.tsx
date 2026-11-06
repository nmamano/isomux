import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocumentLanguage } from "../../../../lib/i18n/document-language";
import { DEFAULT_LANGUAGE } from "../../../../lib/i18n/languages";
import { authorText, zonedTime } from "../../../../lib/incident-time";
import { statusIncident } from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Private: next.config.ts also sends noindex, no-referrer and no-store for
 * every /status path. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

const HOUR_MS = 60 * 60_000;

/**
 * One critical issue and its updates, newest first, from the customer's
 * private link (agreement section 7: "a status page for the issue"). Every
 * time shows in the issue's time zone and in UTC. A bad link and a number that
 * is not this customer's are the same 404.
 */
export default async function StatusIncident({
  params,
}: {
  params: Promise<{ token: string; n: string }>;
}) {
  const { token, n } = await params;
  if (!/^[1-9][0-9]{0,8}$/.test(n)) notFound();
  const view = await statusIncident(token, Number(n));
  if (!view) notFound();
  const zone = view.timeZone;
  const latest = view.updates[0];
  const open = view.status === "open";

  return (
    <>
      <DocumentLanguage language={DEFAULT_LANGUAGE} />
      <p className="page-back">
        <a href={`/status/${token}`}>
          &larr; All issues for {view.customerLabel}
        </a>
      </p>
      <main>
        <h1>
          {view.title}{" "}
          <span data-state={open ? "active" : "done"}>
            {view.kind} &middot; {view.status}
          </span>
        </h1>
        <p className="note">
          Opened {zonedTime(view.openedAt, zone)}. We post an update at least
          every hour until the issue is resolved. Each update also goes by email
          to your contacts.
        </p>
        {open && latest?.estimateAt != null ? (
          <div className="callout">
            <p className="note">Current estimate: resolved by</p>
            <p className="eta">{zonedTime(latest.estimateAt, zone)}</p>
            <p className="note">
              Next update by {zonedTime(view.lastUpdateAt + HOUR_MS, zone)}.
            </p>
          </div>
        ) : null}
        {!open && view.resolvedAt !== null ? (
          <div className="callout">
            <p className="eta">Resolved {zonedTime(view.resolvedAt, zone)}</p>
          </div>
        ) : null}
        <h2>Updates</h2>
        {view.updates.map((update, i) => (
          <div key={update.n} className={i === 0 ? "upd latest" : "upd"}>
            <p className="when">
              {zonedTime(update.postedAt, zone)} &middot;{" "}
              {authorText(update.author)}
            </p>
            <dl>
              <dt>What we found</dt>
              <dd>{update.found}</dd>
              <dt>{update.final ? "What we did" : "What we are doing now"}</dt>
              <dd>{update.doingNow}</dd>
              {update.estimateAt !== null ? (
                <>
                  <dt>Estimate: resolved by</dt>
                  <dd>{zonedTime(update.estimateAt, zone)}</dd>
                </>
              ) : null}
            </dl>
          </div>
        ))}
      </main>
    </>
  );
}
