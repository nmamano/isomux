"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { OpsIncidentsPage } from "../lib/services.server";

type Incident = OpsIncidentsPage["incidents"][number];

const MIN = 60_000;

const NETWORK_ERROR = "Not sent: network error. Try again.";

/** A time on the operator's own clock; the customer's page shows the
 * issue's time zone. */
function when(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function minutes(ms: number): string {
  return `${Math.round(ms / MIN)} min`;
}

/** A datetime-local value (the operator's local time) as epoch ms, or null. */
function epochOf(value: string): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? null : at;
}

/** A text field of a form or an answer; anything else is "". */
function field(
  from: FormData | Record<string, unknown> | null,
  name: string,
): string {
  const value = from instanceof FormData ? from.get(name) : from?.[name];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

async function post(
  path: string,
  body: unknown,
): Promise<{
  ok: boolean;
  data: Record<string, unknown> | null;
  status: number;
}> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { ok: res.ok, data, status: res.status };
}

/** What a post answered, in one line. */
function postNote(result: {
  ok: boolean;
  data: Record<string, unknown> | null;
  status: number;
}): string {
  if (result.ok) {
    const mail = result.data?.mail;
    const mailText =
      mail === "sent"
        ? "the email went to the contacts"
        : mail === "failed"
          ? "the email failed: email the update to the contacts yourself"
          : "no email: AUTH_RESEND_KEY is not set";
    return `Posted update ${field(result.data, "n")}; ${mailText}.`;
  }
  const reason = result.data?.reason;
  return `Refused (${result.status})${typeof reason === "string" ? `: ${reason}` : ""}.`;
}

function UpdateFields({ final }: { final: boolean }) {
  return (
    <>
      <label>
        What we found
        <textarea name="found" required maxLength={4000} />
      </label>
      <label>
        {final ? "What we did" : "What we are doing now"}
        <textarea name="doingNow" required maxLength={4000} />
      </label>
      {final ? null : (
        <label>
          Estimate: resolved by (your local time)
          <input type="datetime-local" name="estimateAt" required />
        </label>
      )}
    </>
  );
}

function updateBody(form: FormData, final: boolean) {
  return {
    found: field(form, "found"),
    doingNow: field(form, "doingNow"),
    estimateAt: final ? null : epochOf(field(form, "estimateAt")),
    final,
  };
}

function IncidentCard({
  incident,
  statusPath,
  now,
}: {
  incident: Incident;
  statusPath: string | undefined;
  now: number;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [final, setFinal] = useState(false);
  const open = incident.status === "open";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let result;
    try {
      result = await post(
        `/api/ops/incidents/${incident.id}/updates`,
        updateBody(new FormData(event.currentTarget), final),
      );
    } catch {
      setNote(NETWORK_ERROR);
      return;
    }
    setNote(postNote(result));
    if (result.ok) window.location.reload();
  };

  return (
    <section className="card" data-testid="ops-incident">
      <h2>
        {incident.customerLabel} issue {incident.n}: {incident.title}{" "}
        <span data-state={open ? "active" : "done"}>
          {incident.kind} &middot; {incident.status}
        </span>
      </h2>
      <p className="note">
        Opened {when(incident.openedAt)}. Contacts:{" "}
        {incident.contacts.join(", ")}. Time zone: {incident.timeZone}.
        {statusPath ? (
          <>
            {" "}
            <a href={`${statusPath}/${incident.n}`}>Customer page</a>
          </>
        ) : null}
      </p>
      {open && incident.dueAt !== null ? (
        incident.lateByMs > 0 ? (
          <p className="callout callout-danger" data-testid="ops-incident-late">
            <strong>Late by {minutes(incident.lateByMs)}.</strong> Post an
            update now.
          </p>
        ) : (
          <p className="note">
            Next update due by {when(incident.dueAt)} (in{" "}
            {minutes(Math.max(0, incident.dueAt - now))}).
          </p>
        )
      ) : null}
      <ol className="rows">
        {incident.updates.map((u) => (
          <li key={u.n}>
            <span className="note">
              {u.n}. {when(u.postedAt)} &middot;{" "}
              {u.author === "engineer"
                ? `engineer ${u.authorRef}`
                : "support agent (key)"}{" "}
              &middot; {minutes(u.gapMs)} after the previous one
              {u.lateByMs > 0 ? (
                <strong> &middot; late by {minutes(u.lateByMs)}</strong>
              ) : null}
            </span>
            <br />
            Found: {u.found}
            <br />
            {u.final ? "Did" : "Doing now"}: {u.doingNow}
            {u.estimateAt !== null ? (
              <>
                <br />
                Estimate: {when(u.estimateAt)}
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {open ? (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <h3>Post an update</h3>
          <p className="note">
            The update goes to the customer page and, in full, to the contacts
            by email. It cannot be changed later: post a correction as a new
            update. Never put secrets or customer data in it.
          </p>
          <UpdateFields final={final} />
          {/* The form's checkbox row (globals.css .form .key-confirm). */}
          <label className="key-confirm">
            <input
              type="checkbox"
              checked={final}
              onChange={(e) => setFinal(e.target.checked)}
            />
            Final update: the issue is resolved
          </label>
          <p>
            <button type="submit">
              {final ? "Post and resolve" : "Post update"}
            </button>
          </p>
          {note ? <p className="note">{note}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function OpenForm({ labels }: { labels: string[] }) {
  const [note, setNote] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let result;
    try {
      result = await post("/api/ops/incidents", {
        customerLabel: field(form, "customerLabel"),
        contacts: field(form, "contacts")
          .split(/[\s,;]+/)
          .filter(Boolean),
        kind: field(form, "kind"),
        timeZone: field(form, "timeZone"),
        title: field(form, "title"),
        first: updateBody(form, false),
      });
    } catch {
      setNote(NETWORK_ERROR);
      return;
    }
    setNote(postNote(result));
    if (result.ok) window.location.reload();
  };
  return (
    <form className="form card" onSubmit={(e) => void submit(e)}>
      <h2>Open an issue</h2>
      <p className="note">
        Opening posts the first update and emails it. Then post an update at
        least every hour until the final one.
      </p>
      <label>
        Customer
        <input
          name="customerLabel"
          required
          maxLength={100}
          list="status-customers"
        />
        <datalist id="status-customers">
          {labels.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
      </label>
      <label>
        Contacts (email addresses, 1 to 10)
        <textarea name="contacts" required />
      </label>
      <label>
        Kind
        <select name="kind" defaultValue="critical">
          <option value="critical">critical</option>
          <option value="security">security</option>
        </select>
      </label>
      <label>
        Customer time zone (IANA, for example America/Chicago)
        <input name="timeZone" required defaultValue="UTC" />
      </label>
      <label>
        Title
        <input name="title" required maxLength={200} />
      </label>
      <UpdateFields final={false} />
      <p>
        <button type="submit">Open and post the first update</button>
      </p>
      {note ? <p className="note">{note}</p> : null}
    </form>
  );
}

/**
 * The second step of a one-way action: the question, then Confirm (which
 * takes the focus, so Enter confirms) and Cancel. It ends on Confirm or
 * Cancel only, never on blur: a browser can drop the focus without a blur.
 */
function ConfirmStep({
  question,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  return (
    <span data-testid="ops-incidents-confirm">
      {question}{" "}
      <button ref={confirm} type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>{" "}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

type Confirming = { kind: "link"; customerId: string } | { kind: "key" } | null;

/** The operator's critical issues: open, post, resolve, links and the key. */
export function OpsIncidents({ initial }: { initial: OpsIncidentsPage }) {
  const view = initial;
  const [shown, setShown] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  // One post per confirm, even on a double click.
  const busy = useRef(false);

  /** One post at a time; null when one is already running or the network
   * failed (which it says). */
  const postOnce = async (path: string) => {
    if (busy.current) return null;
    busy.current = true;
    try {
      return await post(path, {});
    } catch {
      setShown(NETWORK_ERROR);
      return null;
    } finally {
      busy.current = false;
    }
  };

  const remake = async (customerId: string) => {
    setConfirming(null);
    const result = await postOnce(
      `/api/ops/incidents/customers/${customerId}/link`,
    );
    if (!result) return;
    if (result.ok) {
      window.location.reload();
      return;
    }
    setShown(`Refused (${result.status}).`);
  };

  const rotate = async () => {
    setConfirming(null);
    const result = await postOnce("/api/ops/incidents/key");
    if (!result) return;
    setShown(
      result.ok
        ? `New write key, shown once: ${field(result.data, "key")} Give it to the support agent and to the office reminder as INCIDENT_WRITE_KEY.`
        : `Refused (${result.status}).`,
    );
  };

  return (
    <main className="wide">
      <p>
        <a href="/ops">&larr; Ops floor</a>
      </p>
      <h1>Critical issues</h1>
      {view.incidents.length === 0 ? (
        <p className="note">There are no issues.</p>
      ) : (
        view.incidents.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            statusPath={view.statusPaths[incident.customerId]}
            now={view.now}
          />
        ))
      )}
      <OpenForm labels={view.customers.map((c) => c.label)} />

      <h2>Customer links</h2>
      <ul className="card rows">
        {view.customers.map((customer) => (
          <li key={customer.id}>
            {customer.label}:{" "}
            {view.statusPaths[customer.id] ? (
              <a href={view.statusPaths[customer.id]}>status page</a>
            ) : (
              "no link (AUTH_SECRET is not set)"
            )}{" "}
            {confirming?.kind === "link" &&
            confirming.customerId === customer.id ? (
              <ConfirmStep
                question={`Re-make ${customer.label}'s link? Old links stop working, also in emails already sent.`}
                confirmLabel="Re-make link"
                onConfirm={() => void remake(customer.id)}
                onCancel={() => setConfirming(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() =>
                  setConfirming({ kind: "link", customerId: customer.id })
                }
              >
                Re-make link
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>Write key</h2>
      <p className="note">
        The support agent posts updates with this key, and the office reminder
        reads the due issues with it.{" "}
        {view.keySet && view.keyRotatedAt !== null
          ? `Made ${when(view.keyRotatedAt)}.`
          : "No key is set yet."}
      </p>
      <p>
        {confirming?.kind === "key" ? (
          <ConfirmStep
            question="Rotate the write key? The old key stops working for the support agent and the office reminder until they get the new one."
            confirmLabel="Rotate key"
            onConfirm={() => void rotate()}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <button
            type="button"
            onClick={() =>
              view.keySet ? setConfirming({ kind: "key" }) : void rotate()
            }
          >
            {view.keySet ? "Rotate key" : "Make key"}
          </button>
        )}
      </p>
      {shown ? (
        <p className="callout mono" data-testid="ops-incidents-shown">
          {shown}
        </p>
      ) : null}
    </main>
  );
}
