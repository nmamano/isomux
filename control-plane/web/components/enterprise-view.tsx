"use client";

// The enterprise account pages (app/enterprise): set up, the agreement, and
// the one account page. The routes they post to are app/api/enterprise/*; the
// contract calendar and every price come from control-plane/enterprise-billing.ts.

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ADDED_SEAT_MONTH_USD,
  MONTHLY_SEAT_USD,
  YEARLY_SEAT_USD,
  periodTotalUsd,
  quoteSeatChange,
  renewalDate,
  type EnterprisePlan,
} from "../../enterprise-billing";
import type { EnterpriseOfficeView, EnterpriseView } from "../../enterprise";
import { AGREEMENT_HTML } from "../lib/enterprise-agreement-text";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { translatorFor, type Translator } from "../lib/i18n/translate";

type T = Translator["t"];
type Tn = Translator["tn"];

const HELP_EMAIL = "llc@isomux.com";

function usd(language: SupportedLanguageCode, amount: number): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

function day(language: SupportedLanguageCode, at: number): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(at);
}

/** POST a JSON body; the parsed answer, or null on a network error. A 401
 * goes to the sign-in page. */
async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; reason?: string; [key: string]: unknown } | null> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      window.location.assign("/signin");
      return null;
    }
    return (await response.json()) as { ok: boolean; reason?: string };
  } catch {
    return null;
  }
}

/** The sentence for a refused field. */
function invalidText(t: T, field: unknown, maxSeats: number): string {
  switch (field) {
    case "company":
      return t("enterprise.invalid.company");
    case "billingEmail":
      return t("enterprise.invalid.billingEmail");
    case "seats":
      return t("enterprise.invalid.seats", { max: maxSeats });
    case "name":
      return t("enterprise.invalid.name");
    case "title":
      return t("enterprise.invalid.title");
    case "authority":
      return t("enterprise.invalid.authority");
    default:
      return t("enterprise.failed");
  }
}

function Refusal({ text }: { text: string | null }) {
  return text ? (
    <p className="callout callout-danger" role="alert">
      {text}
    </p>
  ) : null;
}

// ------------------------------------------------------------------ set up

export function EnterpriseSetup({
  language,
  email,
  maxSeats,
}: {
  language: SupportedLanguageCode;
  email: string;
  maxSeats: number;
}) {
  const { t } = translatorFor(language);
  const [company, setCompany] = useState("");
  const [billingEmail, setBillingEmail] = useState(email);
  const [plan, setPlan] = useState<EnterprisePlan>("monthly");
  const [seats, setSeats] = useState("50");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const count = Number(seats);
  const valid = Number.isInteger(count) && count >= 1 && count <= maxSeats;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    const answer = await post("/api/enterprise", {
      company,
      billingEmail,
      plan,
      seats: count,
    });
    if (answer?.ok || answer?.reason === "exists") {
      window.location.assign("/enterprise");
      return;
    }
    setRefusal(
      answer?.reason === "invalid"
        ? invalidText(t, answer.field, maxSeats)
        : t("enterprise.failed"),
    );
    setBusy(false);
  }

  return (
    <main lang={language}>
      <h1>{t("enterprise.setup.heading")}</h1>
      <p className="lead">{t("enterprise.setup.lead")}</p>
      <form
        className="card card-narrow form"
        data-testid="enterprise-setup"
        onSubmit={(event) => void submit(event)}
      >
        <p>
          <label>
            {t("enterprise.setup.company")}{" "}
            <input
              name="company"
              required
              autoComplete="organization"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            {t("enterprise.setup.billingEmail")}{" "}
            <input
              name="billingEmail"
              type="email"
              required
              autoComplete="email"
              value={billingEmail}
              onChange={(event) => setBillingEmail(event.target.value)}
            />
          </label>
        </p>
        <fieldset className="enterprise-plans">
          <legend>{t("enterprise.setup.plan")}</legend>
          <label className="choice">
            <input
              type="radio"
              name="plan"
              value="monthly"
              checked={plan === "monthly"}
              onChange={() => setPlan("monthly")}
            />
            {t("enterprise.setup.monthly", {
              price: usd(language, MONTHLY_SEAT_USD),
            })}
          </label>
          <label className="choice">
            <input
              type="radio"
              name="plan"
              value="yearly"
              checked={plan === "yearly"}
              onChange={() => setPlan("yearly")}
            />
            {t("enterprise.setup.yearly", {
              price: usd(language, YEARLY_SEAT_USD),
            })}
          </label>
          {plan === "yearly" && (
            <p className="note">{t("enterprise.setup.yearlyNote")}</p>
          )}
        </fieldset>
        <p>
          <label>
            {t("enterprise.setup.seats")}{" "}
            <input
              name="seats"
              type="number"
              min={1}
              max={maxSeats}
              step={1}
              required
              value={seats}
              onChange={(event) => setSeats(event.target.value)}
            />
          </label>
        </p>
        <p className="note">{t("enterprise.setup.seatsNote")}</p>
        {valid && (
          <p data-testid="enterprise-total">
            <strong>
              {plan === "monthly"
                ? t("enterprise.setup.totalMonthly", {
                    total: usd(language, periodTotalUsd(plan, count)),
                  })
                : t("enterprise.setup.totalYearly", {
                    total: usd(language, periodTotalUsd(plan, count)),
                  })}
            </strong>
          </p>
        )}
        <p className="note">{t("enterprise.setup.trial")}</p>
        <Refusal text={refusal} />
        <button className="btn-primary" type="submit" disabled={busy}>
          {t("enterprise.setup.continue")}
        </button>
      </form>
    </main>
  );
}

// --------------------------------------------------------------- agreement

export function EnterpriseAgreement({
  language,
  company,
  now,
  pdfPath,
}: {
  language: SupportedLanguageCode;
  company: string;
  now: number;
  pdfPath: string;
}) {
  const { t } = translatorFor(language);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [authority, setAuthority] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    const answer = await post("/api/enterprise/agreement", {
      name,
      title,
      authority,
    });
    if (answer?.ok || answer?.reason === "already_signed") {
      window.location.assign("/enterprise");
      return;
    }
    setRefusal(
      answer?.reason === "invalid"
        ? invalidText(t, answer.field, 0)
        : t("enterprise.failed"),
    );
    setBusy(false);
  }

  return (
    <main lang={language} className="wide">
      <h1>{t("enterprise.agreement.heading")}</h1>
      <p className="lead">{t("enterprise.agreement.lead", { company })}</p>
      <p>
        <a href={pdfPath} download data-testid="agreement-pdf">
          {t("enterprise.agreement.download")}
        </a>
      </p>
      <div
        className="agreement-text"
        lang="en"
        tabIndex={0}
        data-testid="agreement-text"
        // Our own constant, never input (lib/enterprise-agreement-text.ts).
        dangerouslySetInnerHTML={{ __html: AGREEMENT_HTML }}
      />
      <form
        className="card card-narrow form"
        data-testid="agreement-form"
        onSubmit={(event) => void submit(event)}
      >
        <p>
          <label>
            {t("enterprise.agreement.name")}{" "}
            <input
              name="name"
              required
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            {t("enterprise.agreement.title")}{" "}
            <input
              name="title"
              required
              autoComplete="organization-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </p>
        <p>
          {t("enterprise.agreement.company")}: <strong>{company}</strong>
          <br />
          {t("enterprise.agreement.date")}:{" "}
          <strong>{day(language, now)}</strong>
        </p>
        <p>
          <label className="choice">
            <input
              type="checkbox"
              name="authority"
              checked={authority}
              onChange={(event) => setAuthority(event.target.checked)}
            />
            {t("enterprise.agreement.authority", { company })}
          </label>
        </p>
        <Refusal text={refusal} />
        <button className="btn-primary" type="submit" disabled={busy}>
          {t("enterprise.agreement.sign")}
        </button>
      </form>
    </main>
  );
}

// ------------------------------------------------------------ account page

export function EnterpriseAccount({
  language,
  view,
  now,
  pdfPath,
  maxSeats,
  maxOfficeName,
}: {
  language: SupportedLanguageCode;
  view: EnterpriseView;
  now: number;
  pdfPath: string;
  maxSeats: number;
  /** enterprise.ts MAX_OFFICE_NAME_LENGTH, from the server page. */
  maxOfficeName: number;
}) {
  const { t, tn } = translatorFor(language);
  const start = view.contractStart ?? now;
  // Here, not in Seats: a removed office's members leave the Seats count.
  const [inUse, setInUse] = useState(view.inUse);
  return (
    <main lang={language}>
      <h1>{t("enterprise.heading")}</h1>
      <p className="lead">{view.company}</p>
      <Seats
        t={t}
        tn={tn}
        language={language}
        view={view}
        start={start}
        now={now}
        maxSeats={maxSeats}
        inUse={inUse}
        setInUse={setInUse}
      />
      <Offices
        t={t}
        language={language}
        initial={view.offices}
        maxName={maxOfficeName}
        onRemoved={(members) => setInUse((n) => Math.max(0, n - members))}
      />
      {view.secret && <Secret t={t} initial={view.secret} />}
      <div className="card">
        <h2>{t("enterprise.billing.heading")}</h2>
        <p>
          {view.kind === "negotiated"
            ? view.plan === "monthly"
              ? t("enterprise.billing.negotiatedMonthly", {
                  note: view.priceNote ?? "",
                })
              : t("enterprise.billing.negotiatedYearly", {
                  note: view.priceNote ?? "",
                })
            : view.plan === "monthly"
              ? t("enterprise.billing.monthly", {
                  price: usd(language, MONTHLY_SEAT_USD),
                })
              : t("enterprise.billing.yearly", {
                  price: usd(language, YEARLY_SEAT_USD),
                })}
        </p>
        {view.plan === "yearly" && (
          <p>
            {t("enterprise.billing.renewal", {
              date: day(language, renewalDate(start, now)),
            })}
          </p>
        )}
        <p>{t("enterprise.billing.invoices", { email: view.billingEmail })}</p>
      </div>
      <div className="card">
        <h2>{t("enterprise.agreementCard.heading")}</h2>
        {view.signature ? (
          <>
            <p>
              {t("enterprise.agreementCard.signed", {
                name: view.signature.name,
                title: view.signature.title,
                date: day(language, view.signature.at),
              })}
            </p>
            <p>
              <a href={pdfPath} download>
                {t("enterprise.agreement.download")}
              </a>
            </p>
          </>
        ) : (
          <p>{t("enterprise.agreementCard.negotiated")}</p>
        )}
      </div>
      <div className="card" data-testid="enterprise-over">
        <h2>{t("enterprise.over.heading")}</h2>
        <p>{t("enterprise.over.body")}</p>
      </div>
      <p className="note">{t("enterprise.help", { email: HELP_EMAIL })}</p>
    </main>
  );
}

function Seats({
  t,
  tn,
  language,
  view,
  start,
  now,
  maxSeats,
  inUse,
  setInUse,
}: {
  t: T;
  tn: Tn;
  language: SupportedLanguageCode;
  view: EnterpriseView;
  start: number;
  now: number;
  maxSeats: number;
  inUse: number;
  setInUse: (inUse: number) => void;
}) {
  const [seats, setSeats] = useState(view.seats);
  const [draft, setDraft] = useState(String(view.seats));
  const [quote, setQuote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The cost of the change, or the reason it cannot be made. */
  function review(event: FormEvent) {
    event.preventDefault();
    setRefusal(null);
    setQuote(null);
    const to = Number(draft);
    if (!Number.isInteger(to) || to < 1 || to > maxSeats) {
      setRefusal(t("enterprise.invalid.seats", { max: maxSeats }));
      return;
    }
    if (to === seats) return;
    if (view.plan === "yearly" && to < seats) {
      setRefusal(
        t("enterprise.seats.yearlyDecrease", {
          date: day(language, renewalDate(start, now)),
        }),
      );
      return;
    }
    if (to < inUse) {
      setRefusal(tn("enterprise.seats.belowInUse", inUse));
      return;
    }
    // A negotiated price is not ours to compute here.
    if (view.kind === "negotiated") {
      setQuote(tn("enterprise.seats.quoteNegotiated", to));
      return;
    }
    const q = quoteSeatChange(view.plan, start, now, seats, to);
    setQuote(
      q.plan === "monthly"
        ? q.lowering
          ? tn("enterprise.seats.quoteMonthlyLower", to, {
              total: usd(language, q.monthTotalUsd),
            })
          : tn("enterprise.seats.quoteMonthly", to, {
              total: usd(language, q.monthTotalUsd),
            })
        : tn("enterprise.seats.quoteYearly", q.monthsLeft, {
            added: q.added,
            price: usd(language, ADDED_SEAT_MONTH_USD),
            amount: usd(language, q.amountUsd),
            date: day(language, q.invoicedAt),
          }),
    );
  }

  async function confirm() {
    setBusy(true);
    const to = Number(draft);
    const answer = await post("/api/enterprise/seats", { from: seats, to });
    setBusy(false);
    setQuote(null);
    if (answer?.ok) {
      setSeats(to);
      return;
    }
    if (typeof answer?.seats === "number") setSeats(answer.seats);
    if (typeof answer?.inUse === "number") setInUse(answer.inUse);
    setRefusal(
      answer?.reason === "stale"
        ? t("enterprise.seats.stale", { seats: Number(answer.seats) })
        : answer?.reason === "below_in_use"
          ? tn("enterprise.seats.belowInUse", Number(answer.inUse))
          : t("enterprise.failed"),
    );
  }

  return (
    <div className="card" data-testid="enterprise-seats">
      <h2>{t("enterprise.seats.heading")}</h2>
      <p>
        <strong>{tn("enterprise.seats.inUse", seats, { inUse })}</strong>
      </p>
      <form className="form enterprise-inline" onSubmit={review}>
        <label>
          {t("enterprise.seats.newCount")}{" "}
          <input
            name="seats"
            type="number"
            min={1}
            max={maxSeats}
            step={1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setQuote(null);
            }}
          />
        </label>
        <button type="submit">{t("enterprise.seats.review")}</button>
      </form>
      {quote && (
        <div className="callout" data-testid="seat-quote">
          <p>{quote}</p>
          <button
            className="btn-primary"
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {t("enterprise.seats.confirm")}
          </button>{" "}
          <button type="button" onClick={() => setQuote(null)}>
            {t("enterprise.seats.cancel")}
          </button>
        </div>
      )}
      <Refusal text={refusal} />
    </div>
  );
}

/** The refusal for an office change. */
function officeRefusal(t: T, reason: unknown, maxName: number): string {
  switch (reason) {
    case "invalid":
      return t("enterprise.offices.invalidName", { max: maxName });
    case "not_found":
      return t("enterprise.offices.gone");
    default:
      return t("enterprise.failed");
  }
}

/** The offices, with Rename in place and Remove after a confirm in the row.
 * One of the two is open at a time. */
function Offices({
  t,
  language,
  initial,
  maxName,
  onRemoved,
}: {
  t: T;
  language: SupportedLanguageCode;
  initial: EnterpriseOfficeView[];
  maxName: number;
  onRemoved: (members: number) => void;
}) {
  const [offices, setOffices] = useState(initial);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // The open control takes the focus: Chrome drops it from a button that is
  // disabled during the post, and Safari does not focus a clicked button.
  useEffect(() => {
    if (renaming) nameField.current?.focus();
  }, [renaming]);
  useEffect(() => {
    if (removing) confirmButton.current?.focus();
  }, [removing]);

  function close() {
    setRenaming(null);
    setRemoving(null);
    setRefusal(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const office = renaming;
    if (!office) return;
    setBusy(true);
    setRefusal(null);
    const answer = await post("/api/enterprise/offices/rename", {
      office,
      name: draft,
    });
    setBusy(false);
    if (answer?.ok) {
      const name = draft.trim();
      setOffices((list) =>
        list.map((o) => (o.id === office ? { ...o, name } : o)),
      );
      close();
      return;
    }
    setRefusal(officeRefusal(t, answer?.reason, maxName));
  }

  async function remove() {
    const office = offices.find((o) => o.id === removing);
    if (!office) return;
    setBusy(true);
    setRefusal(null);
    const answer = await post("/api/enterprise/offices/remove", {
      office: office.id,
    });
    setBusy(false);
    if (answer?.ok) {
      setOffices((list) => list.filter((o) => o.id !== office.id));
      onRemoved(office.members);
      close();
      return;
    }
    setRefusal(officeRefusal(t, answer?.reason, maxName));
  }

  return (
    <div className="card" data-testid="enterprise-offices">
      <h2>{t("enterprise.offices.heading")}</h2>
      {offices.length === 0 ? (
        <p className="note">{t("enterprise.offices.empty")}</p>
      ) : (
        <div className="table-scroll">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t("enterprise.offices.name")}</th>
                <th>{t("enterprise.offices.members")}</th>
                <th>{t("enterprise.offices.lastSeen")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offices.map((office) => (
                <Fragment key={office.id}>
                  <tr data-office={office.id}>
                    <td>
                      {renaming === office.id ? (
                        <form
                          className="form enterprise-inline"
                          onSubmit={(event) => void save(event)}
                        >
                          <input
                            ref={nameField}
                            name="officeName"
                            className="enterprise-office-name"
                            aria-label={t("enterprise.offices.nameLabel")}
                            maxLength={maxName}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                          />{" "}
                          <button
                            className="btn-primary"
                            type="submit"
                            data-action="save"
                            disabled={busy}
                          >
                            {t("enterprise.offices.save")}
                          </button>{" "}
                          <button
                            type="button"
                            data-action="cancel"
                            onClick={close}
                          >
                            {t("enterprise.seats.cancel")}
                          </button>
                        </form>
                      ) : (
                        (office.name ?? t("enterprise.offices.unnamed"))
                      )}
                    </td>
                    <td>{office.members}</td>
                    <td>{day(language, office.lastSeenAt)}</td>
                    <td>
                      {removing !== office.id && renaming !== office.id && (
                        <>
                          <button
                            type="button"
                            data-action="rename"
                            onClick={() => {
                              close();
                              setDraft(office.name ?? "");
                              setRenaming(office.id);
                            }}
                          >
                            {t("enterprise.offices.rename")}
                          </button>{" "}
                          <button
                            type="button"
                            data-action="remove"
                            onClick={() => {
                              close();
                              setRemoving(office.id);
                            }}
                          >
                            {t("enterprise.offices.remove")}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {removing === office.id && (
                    <tr data-office-confirm={office.id}>
                      <td colSpan={4}>
                        <div className="callout callout-danger">
                          <p>{t("enterprise.offices.removeWarning")}</p>
                          <button
                            ref={confirmButton}
                            type="button"
                            data-action="confirm-remove"
                            disabled={busy}
                            onClick={() => void remove()}
                          >
                            {t("enterprise.offices.removeConfirm")}
                          </button>{" "}
                          <button
                            type="button"
                            data-action="cancel"
                            onClick={close}
                          >
                            {t("enterprise.seats.cancel")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Refusal text={refusal} />
    </div>
  );
}

function Secret({ t, initial }: { t: T; initial: string }) {
  const [secret, setSecret] = useState(initial);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy() {
    // A failed copy keeps the secret masked: the member may be sharing the
    // screen (Nil: "screen sharing mishaps").
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  async function renew() {
    setBusy(true);
    setRefusal(null);
    const answer = await post("/api/enterprise/secret", {});
    setBusy(false);
    if (answer?.ok && typeof answer.secret === "string") {
      setSecret(answer.secret);
      setShown(false);
      setCopied(false);
      setCopyFailed(false);
      setRenewing(false);
      return;
    }
    setRefusal(t("enterprise.failed"));
  }

  return (
    <div className="card" data-testid="enterprise-secret">
      <h2>{t("enterprise.secret.heading")}</h2>
      <p>{t("enterprise.secret.lead")}</p>
      <p>
        <code className="mono enterprise-secret" data-testid="secret-value">
          {shown ? secret : "•".repeat(24)}
        </code>
      </p>
      <p>
        <button type="button" onClick={() => setShown(!shown)}>
          {shown ? t("enterprise.secret.hide") : t("enterprise.secret.show")}
        </button>{" "}
        <button type="button" onClick={() => void copy()}>
          {copied ? t("enterprise.secret.copied") : t("enterprise.secret.copy")}
        </button>{" "}
        {!renewing && (
          <button type="button" onClick={() => setRenewing(true)}>
            {t("enterprise.secret.renew")}
          </button>
        )}
      </p>
      {copyFailed && (
        <p className="note" role="status">
          {t("enterprise.secret.copyFailed")}
        </p>
      )}
      {renewing && (
        <div className="callout callout-danger" data-testid="secret-renew">
          <p>{t("enterprise.secret.renewWarning")}</p>
          <button type="button" disabled={busy} onClick={() => void renew()}>
            {t("enterprise.secret.renewConfirm")}
          </button>{" "}
          <button type="button" onClick={() => setRenewing(false)}>
            {t("enterprise.seats.cancel")}
          </button>
        </div>
      )}
      <Refusal text={refusal} />
    </div>
  );
}
