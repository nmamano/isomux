// Integrations > Model providers (task 3e70b6d4): every provider account the
// office's agents can run on, with its weekly, 5-hour and per-model usage,
// read from the provider. Owners only: the rows carry account emails.
//
// The list comes at once with what the server holds; each row that loads is
// read on its own route. A row takes its place by weekly headroom (week
// passed minus used) when its reading arrives, and placed rows never move
// during one load. Refresh reads every account again and sorts once. No
// polling.
//
// While the list loads, the card holds the rows it drew last on this device
// (AGENTS.md UI rules). `readOnly`: a member, whose card keeps its place with
// Refresh disabled, and reads nothing.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch } from "../api.ts";
import type {
  AccountUsageListRes,
  AccountUsageRowWire,
} from "../../shared/contract-shapes.ts";
import type { SubscriptionWindowWire } from "../../shared/types.ts";
import {
  ACCOUNT_USAGE_AGE_MS,
  accountUsageOrder,
  accountUsageRowShape,
  foldAccountUsageRow,
  heldAccountUsageRow,
  sameAccountUsage,
  weekElapsedPercent,
  type AccountUsageRowShape,
} from "../../shared/account-usage.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { useI18n } from "../i18n.tsx";
import { cardStyle } from "./access-shared.tsx";
import { Reserved } from "./Reserved.tsx";
import { Btn } from "../integrations/kit.tsx";
import {
  getAccountUsageLayout,
  setAccountUsageLayout,
} from "../device-settings.ts";
import { formatTimeUntil, windowLine } from "../log-view/SubscriptionPill.tsx";

const LIST = "/api/office/account-usage";
// A held line's text: a no-break space keeps the line's height, where a
// plain space collapses.
const BLANK = "\u00a0";

type I18n = ReturnType<typeof useI18n>;

// The rows in the card's order: the placed ones, then the loading ones.
function shownRows(
  rows: readonly AccountUsageRowWire[],
  placed: readonly string[],
): AccountUsageRowWire[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [
    ...placed.map((id) => byId.get(id)).filter((row) => row !== undefined),
    ...rows.filter((row) => row.state === "loading"),
  ];
}

// Once no row loads, the rows drawn are the layout the next visit holds.
function rememberLayout(
  rows: readonly AccountUsageRowWire[],
  placed: readonly string[],
  now: number,
): void {
  const shapes = shownRows(rows, placed).map((row) =>
    accountUsageRowShape(row, now),
  );
  if (shapes.every((shape) => shape !== null)) setAccountUsageLayout(shapes);
}

export function AccountUsageCard({
  style,
  readOnly = false,
}: {
  // The Integrations page lays the card flat inside its own card.
  style?: CSSProperties;
  readOnly?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [rows, setRows] = useState<AccountUsageRowWire[] | null>(null);
  // The order of the loaded rows on the card.
  const [placed, setPlaced] = useState<string[]>([]);
  const [error, setError] = useState(false);
  // The mount read is out until its answer.
  const [busy, setBusy] = useState(!readOnly);
  // The clock the rows render against: stamped at each answer, so a render
  // stays a function of the state.
  const [now, setNow] = useState(() => Date.now());
  const [held] = useState(getAccountUsageLayout);
  // Each load (and unmount) moves it on; an older answer is dropped.
  const load = useRef(0);
  // The rows and order as the last answer left them, for the row reads.
  const latest = useRef<{ rows: AccountUsageRowWire[]; placed: string[] }>({
    rows: [],
    placed: [],
  });

  // Refresh: every account read again, and one new sort.
  function refresh() {
    setBusy(true);
    setError(false);
    read(true);
  }

  function adopt(nextRows: AccountUsageRowWire[], nextPlaced: string[]) {
    const at = Date.now();
    latest.current = { rows: nextRows, placed: nextPlaced };
    setNow(at);
    setRows(nextRows);
    setPlaced(nextPlaced);
    if (nextRows.every((row) => row.state !== "loading"))
      rememberLayout(nextRows, nextPlaced, at);
  }

  function read(refresh: boolean) {
    const current = ++load.current;
    apiFetch<AccountUsageListRes>("GET", refresh ? `${LIST}?refresh=1` : LIST)
      .then((answer) => {
        if (current !== load.current) return;
        // An answer with no row list (a server from before the route) lists
        // nothing.
        const list = Array.isArray(answer?.rows) ? answer.rows : [];
        // A new load sorts once.
        adopt(list, accountUsageOrder([], list, Date.now()));
        for (const row of list)
          if (row.state === "loading") readRow(current, row.id);
      })
      .catch(() => {
        if (current === load.current) setError(true);
      })
      .finally(() => {
        if (current === load.current) setBusy(false);
      });
  }

  function readRow(current: number, id: string) {
    void apiFetch<AccountUsageRowWire>(
      "GET",
      `${LIST}/${encodeURIComponent(id)}`,
    )
      .catch((): AccountUsageRowWire | null => null)
      .then((answer) => {
        if (current !== load.current) return;
        const before = latest.current.rows;
        const loadingRow = before.find((row) => row.id === id);
        if (!loadingRow) return;
        const arrived = answer ?? { ...loadingRow, state: "failed" as const };
        // The server merges rows of one account only when both readings are
        // in at the list: a row that arrives with the account of a row on
        // the card folds into it, which keeps its id and place.
        const host = before.find(
          (row) =>
            row.id !== id &&
            row.state !== "loading" &&
            sameAccountUsage(row, arrived),
        );
        const next = host
          ? before
              .filter((row) => row.id !== id)
              .map((row) =>
                row.id === host.id ? foldAccountUsageRow(row, arrived) : row,
              )
          : before.map((row) => (row.id === id ? arrived : row));
        adopt(next, accountUsageOrder(latest.current.placed, next, Date.now()));
      });
  }

  useEffect(() => {
    if (readOnly) return;
    read(false);
    const reads = load;
    return () => {
      reads.current++;
    };
    // One load at mount; Refresh starts the others. readOnly is the
    // viewer's role, which does not change while the card shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loading = !readOnly && rows === null && !error;
  const shown = rows ? shownRows(rows, placed) : [];

  return (
    <section
      data-account-usage
      aria-busy={loading}
      style={{ ...cardStyle, marginTop: 14, ...style }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>{t("accountUsage.title")}</strong>
        <Btn
          small
          data-account-usage-refresh
          disabled={readOnly || busy}
          onClick={refresh}
        >
          {t("accountUsage.refresh")}
        </Btn>
      </div>
      <p style={hint}>{t("accountUsage.hint")}</p>
      {error && (
        <p role="alert" style={{ ...hint, color: "var(--red-text)" }}>
          {t("accountUsage.listFailed")}
        </p>
      )}
      {/* While the list loads: the rows drawn last, dimmed, or the line
          that stands for no rows. */}
      {loading &&
        (held.length > 0 ? (
          <Reserved dim>
            {held.map((shape, index) => (
              <AccountRow
                key={index}
                row={heldAccountUsageRow(shape, `held-${index}`, now)}
                now={now}
                i18n={i18n}
                held
              />
            ))}
          </Reserved>
        ) : (
          <p role="status" style={hint}>
            {t("accountUsage.loading")}
          </p>
        ))}
      {rows !== null && rows.length === 0 && !error && (
        <p style={hint}>{t("accountUsage.empty")}</p>
      )}
      {shown.map((row) => (
        <AccountRow key={row.id} row={row} now={now} i18n={i18n} />
      ))}
    </section>
  );
}

// The shape a row draws while its own read is out: a weekly and a 5-hour bar.
const LOADING_SHAPE: AccountUsageRowShape = {
  state: "usage",
  weekly: true,
  resets: true,
  others: 1,
  members: false,
  age: false,
};

function AccountRow({
  row,
  now,
  i18n,
  held = false,
}: {
  row: AccountUsageRowWire;
  now: number;
  i18n: I18n;
  // A blank row of the held layout: its lines draw no text.
  held?: boolean;
}) {
  if (row.state === "loading")
    return (
      <div data-account-row={row.id} data-loading style={rowStyle}>
        <div style={headStyle}>{rowHead(row, i18n.t)}</div>
        <Reserved dim>
          <RowBody
            row={heldAccountUsageRow(LOADING_SHAPE, row.id, now)}
            now={now}
            i18n={i18n}
            held
          />
        </Reserved>
      </div>
    );
  return (
    <div data-account-row={held ? undefined : row.id} style={rowStyle}>
      <div style={headStyle}>{held ? BLANK : rowHead(row, i18n.t)}</div>
      <RowBody row={row} now={now} i18n={i18n} held={held} />
    </div>
  );
}

// Whose account it is, its email, the provider and the plan.
function rowHead(row: AccountUsageRowWire, t: I18n["t"]): string {
  const owners = row.owners
    .map((owner) =>
      owner.kind === "office" ? t("accountUsage.office") : owner.username,
    )
    .join(", ");
  return [
    owners,
    row.accountLabel,
    row.provider === "claude" ? "Claude" : "Codex",
    row.plan ? t("subscription.plan", { plan: row.plan }) : null,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
}

function RowBody({
  row,
  now,
  i18n,
  held,
}: {
  row: AccountUsageRowWire;
  now: number;
  i18n: I18n;
  held: boolean;
}) {
  const { t, language } = i18n;
  const text = (line: string) => (held ? BLANK : line);
  const weekly =
    row.weeklyIndex === null ? null : (row.windows[row.weeklyIndex] ?? null);
  const others = row.windows.filter((w) => w !== weekly);
  const passed = weekly ? weekElapsedPercent(weekly.resetsAtMs, now) : null;
  const stateLine =
    row.state === "no_limit"
      ? t("accountUsage.noLimit")
      : row.state === "signed_out"
        ? t("accountUsage.signedOut")
        : row.state === "failed"
          ? t("accountUsage.failed")
          : null;
  return (
    <>
      {stateLine && (
        <p
          style={{
            ...hint,
            ...(row.state === "failed" ? { color: "var(--red-text)" } : {}),
          }}
        >
          {text(stateLine)}
        </p>
      )}
      {weekly && (
        <WindowBar
          win={weekly}
          now={now}
          i18n={i18n}
          passed={passed}
          held={held}
        />
      )}
      {passed !== null && (
        <p style={hint}>
          {text(
            t("accountUsage.weekPassed", {
              percent: formatNumber(language, Math.round(passed)),
            }),
          )}
        </p>
      )}
      {others.map((win, index) => (
        <WindowBar
          key={index}
          win={win}
          now={now}
          i18n={i18n}
          held={held}
          small
        />
      ))}
      {row.members.length > 0 && (
        <p style={hint}>
          {text(t("accountUsage.members", { names: row.members.join(", ") }))}
        </p>
      )}
      {row.observedAtMs !== null &&
        now - row.observedAtMs >= ACCOUNT_USAGE_AGE_MS && (
          <p style={hint}>
            {text(
              t("subscription.readingAge", {
                age: formatTimeUntil(i18n, now - row.observedAtMs),
              }),
            )}
          </p>
        )}
    </>
  );
}

// One window: its line, and a bar of the used share. The weekly bar has a
// tick at the share of the week that has passed.
function WindowBar({
  win,
  now,
  i18n,
  passed = null,
  small = false,
  held,
}: {
  win: SubscriptionWindowWire;
  now: number;
  i18n: I18n;
  passed?: number | null;
  small?: boolean;
  held: boolean;
}) {
  const used = Math.max(0, Math.min(100, win.usedPercent));
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ ...hint, margin: 0 }}>
        {held ? BLANK : windowLine(i18n, win, now)}
      </div>
      <div
        style={{
          position: "relative",
          height: small ? 4 : 8,
          borderRadius: 4,
          background: "var(--border-subtle)",
          marginTop: 3,
          maxWidth: small ? 240 : 360,
        }}
      >
        <div
          style={{
            width: `${used}%`,
            height: "100%",
            borderRadius: 4,
            background:
              passed !== null && used > passed
                ? "var(--red-text)"
                : "var(--accent-text)",
          }}
        />
        {passed !== null && (
          <div
            data-week-passed
            style={{
              position: "absolute",
              left: `${passed}%`,
              top: -3,
              bottom: -3,
              width: 2,
              background: "var(--text-primary)",
            }}
          />
        )}
      </div>
    </div>
  );
}

const hint: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  margin: "4px 0 0",
  lineHeight: 1.4,
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--border-subtle)",
  padding: "8px 0",
  marginTop: 6,
};

const headStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--text-primary)",
};
