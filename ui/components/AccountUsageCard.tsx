// Integrations > Model providers (tasks 3e70b6d4, faf036ad): the Usage card,
// above the sign-in cards. Every provider account the office's agents can run
// on, with its weekly, 5-hour and per-model usage, read from the provider. An
// owner sees every account; a member the office's and their own (the server
// cuts the list). The office's accounts come first, Claude before Codex; then
// the members' (or the member's own). A row is one line, tinted by its
// provider; a click on it opens its details.
//
// The list comes at once with what the server holds; each row that loads is
// read on its own route. A row takes its place by weekly headroom (week
// passed minus used) when its reading arrives, and placed rows never move
// during one load. Refresh reads every account again and sorts once. No
// polling.
//
// While the list loads, the card holds the rows it drew last on this device
// (AGENTS.md UI rules).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
  isOfficeAccountUsage,
  sameAccountUsage,
  weekElapsedPercent,
} from "../../shared/account-usage.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { useI18n } from "../i18n.tsx";
import { cardStyle } from "./access-shared.tsx";
import { Reserved } from "./Reserved.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { useAppState } from "../store.tsx";
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

// Who reads the card: their username names their own rows, and an owner's
// second section is every member's.
export type AccountUsageViewer = { username: string; owner: boolean };

// The rows in the card's order: the office's (Claude before Codex), then the
// others; in each, the placed ones, then the loading ones.
function shownRows(
  rows: readonly AccountUsageRowWire[],
  placed: readonly string[],
): AccountUsageRowWire[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = [
    ...placed.map((id) => byId.get(id)).filter((row) => row !== undefined),
    ...rows.filter((row) => row.state === "loading"),
  ];
  const office = ordered.filter(isOfficeAccountUsage);
  // Array.prototype.sort is stable: Claude rows first, each kept in order.
  office.sort(
    (a, b) => Number(a.provider !== "claude") - Number(b.provider !== "claude"),
  );
  return [...office, ...ordered.filter((row) => !isOfficeAccountUsage(row))];
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
  viewer,
}: {
  style?: CSSProperties;
  viewer: AccountUsageViewer;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [rows, setRows] = useState<AccountUsageRowWire[] | null>(null);
  // The order of the loaded rows on the card.
  const [placed, setPlaced] = useState<string[]>([]);
  const [error, setError] = useState(false);
  // The mount read is out until its answer.
  const [busy, setBusy] = useState(true);
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
    read(false);
    const reads = load;
    return () => {
      reads.current++;
    };
    // One load at mount; Refresh starts the others.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The two-line rows below the width the one-line grid needs, measured on
  // the card (a phone, or a narrow window).
  const cardRef = useRef<HTMLElement>(null);
  const { isMobile } = useAppState();
  const [narrow, setNarrow] = useState(isMobile);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => setNarrow(card.clientWidth < WIDE_MIN_WIDTH);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const loading = rows === null && !error;
  const shown = rows ? shownRows(rows, placed) : [];
  const second = viewer.owner ? "members" : "yours";

  return (
    <section
      ref={cardRef}
      data-account-usage
      aria-busy={loading}
      style={{ ...cardStyle, marginTop: 0, marginBottom: 16, ...style }}
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
        <strong style={{ fontSize: 14 }}>{t("accountUsage.title")}</strong>
        <Btn small data-account-usage-refresh disabled={busy} onClick={refresh}>
          {t("accountUsage.refresh")}
        </Btn>
      </div>
      <p style={hint}>
        {i18n.rich("accountUsage.hint", { tick: <span style={legendTick} /> })}
      </p>
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
            <Sections
              rows={held.map((shape, index) =>
                heldAccountUsageRow(shape, `held-${index}`, now),
              )}
              second={second}
              i18n={i18n}
              render={(row) => (
                <AccountRow
                  key={row.id}
                  row={row}
                  now={now}
                  i18n={i18n}
                  viewer={viewer}
                  narrow={narrow}
                  held
                />
              )}
            />
          </Reserved>
        ) : (
          <p role="status" style={hint}>
            {t("accountUsage.loading")}
          </p>
        ))}
      {rows !== null && rows.length === 0 && !error && (
        <p style={hint}>{t("accountUsage.empty")}</p>
      )}
      <Sections
        rows={shown}
        second={second}
        i18n={i18n}
        render={(row) => (
          <AccountRow
            key={row.id}
            row={row}
            now={now}
            i18n={i18n}
            viewer={viewer}
            narrow={narrow}
          />
        )}
      />
    </section>
  );
}

// The office's rows under "Office-wide", the others under "Members" (an
// owner) or "Yours" (a member). A section with no row is left out.
function Sections({
  rows,
  second,
  i18n,
  render,
}: {
  rows: readonly AccountUsageRowWire[];
  second: "members" | "yours";
  i18n: I18n;
  render: (row: AccountUsageRowWire) => ReactNode;
}) {
  const { t } = i18n;
  const parts = [
    {
      id: "office",
      label: t("integrations.office"),
      rows: rows.filter(isOfficeAccountUsage),
    },
    {
      id: second,
      label:
        second === "members"
          ? t("accountUsage.sectionMembers")
          : t("accountUsage.sectionYours"),
      rows: rows.filter((row) => !isOfficeAccountUsage(row)),
    },
  ];
  return (
    <>
      {parts
        .filter((part) => part.rows.length > 0)
        .map((part) => (
          <div key={part.id} data-account-usage-section={part.id}>
            <div style={sectionLabel}>{part.label}</div>
            {part.rows.map(render)}
          </div>
        ))}
    </>
  );
}

// The provider's tint (Nil, 2026-11-20: subtle colour per provider): the
// stripe, the row's wash and the bars. Claude's is its mark's colour.
const PROVIDER_RGB: Record<AccountUsageRowWire["provider"], string> = {
  claude: "217, 119, 87",
  codex: "16, 163, 127",
};

function AccountRow({
  row,
  now,
  i18n,
  viewer,
  narrow,
  held = false,
}: {
  row: AccountUsageRowWire;
  now: number;
  i18n: I18n;
  viewer: AccountUsageViewer;
  narrow: boolean;
  // A blank row of the held layout: its lines draw no text.
  held?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t, language } = i18n;
  const rgb = PROVIDER_RGB[row.provider];
  const loading = row.state === "loading";
  const weekly =
    row.weeklyIndex === null ? null : (row.windows[row.weeklyIndex] ?? null);
  const others = row.windows.filter((w) => w !== weekly);
  const passed = weekly ? weekElapsedPercent(weekly.resetsAtMs, now) : null;
  const used =
    weekly === null ? null : Math.max(0, Math.min(100, weekly.usedPercent));
  const overPace = !held && used !== null && passed !== null && used > passed;
  const text = (line: string) => (held || loading ? BLANK : line);
  const stateLine =
    row.state === "no_limit"
      ? t("accountUsage.noLimit")
      : row.state === "signed_out"
        ? t("accountUsage.signedOut")
        : row.state === "failed"
          ? t("accountUsage.failed")
          : null;
  // A row with no reading has no details.
  const canOpen = !held && row.state === "usage";
  const toggle = () => {
    if (canOpen) setOpen((was) => !was);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  const label = held || loading ? null : whoLabel(row, viewer, t);
  const grid = narrow ? NARROW_GRID : WIDE_GRID;
  return (
    <div
      data-account-row={held ? undefined : row.id}
      data-held-row={held ? "" : undefined}
      data-loading={loading ? "" : undefined}
      data-over-pace={overPace ? "" : undefined}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-expanded={canOpen ? open : undefined}
      onClick={toggle}
      onKeyDown={canOpen ? onKey : undefined}
      style={{
        borderLeft: `3px solid rgba(${rgb}, 0.75)`,
        background: `rgba(${rgb}, 0.05)`,
        borderRadius: 6,
        padding: "8px 10px",
        marginTop: 6,
        cursor: canOpen ? "pointer" : undefined,
      }}
    >
      <div style={{ ...lineStyle, gridTemplateColumns: grid.columns }}>
        <div style={{ ...whoStyle, gridColumn: grid.who }}>
          <ProviderMark provider={row.provider} size={18} />
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
              {label ?? BLANK}
              {row.plan && !held && (
                <span style={planPill(rgb)}>{row.plan}</span>
              )}
            </div>
            {row.accountLabel !== null && (
              <div style={emailStyle}>{held ? BLANK : row.accountLabel}</div>
            )}
          </div>
        </div>
        {narrow && <Chevron open={open} shown={canOpen} />}
        {stateLine ? (
          <span
            style={{
              ...stateStyle,
              gridColumn: grid.state,
              ...(row.state === "failed" ? { color: "var(--red-text)" } : {}),
            }}
          >
            {held ? BLANK : stateLine}
          </span>
        ) : (
          <>
            <WeekBar used={used ?? 0} passed={passed} rgb={rgb} />
            <span
              style={{
                ...paceStyle,
                gridColumn: grid.pace,
                color: overPace ? "var(--red-text)" : "var(--text-primary)",
              }}
            >
              {used === null || held || loading
                ? BLANK
                : passed === null
                  ? i18n.rich("accountUsage.used", {
                      used: formatNumber(language, Math.round(used)),
                      strong,
                    })
                  : i18n.rich("accountUsage.pace", {
                      used: formatNumber(language, Math.round(used)),
                      passed: formatNumber(language, Math.round(passed)),
                      strong,
                    })}
            </span>
            <div style={{ ...minisStyle, gridColumn: grid.minis }}>
              {/* A held row has no small bars: a blank one keeps the line
                  the two-line layout gives them. */}
              {others.length === 0 && <span style={miniStyle}>{BLANK}</span>}
              {others.map((win, index) => (
                <MiniBar
                  key={index}
                  label={text(miniLabel(win))}
                  used={win.usedPercent}
                  rgb={rgb}
                  language={language}
                  blank={held || loading}
                />
              ))}
            </div>
          </>
        )}
        {!narrow && <Chevron open={open} shown={canOpen} />}
      </div>
      {open && canOpen && (
        <div data-account-row-details style={detailsStyle}>
          {row.windows.map((win, index) => (
            <div key={index}>{windowLine(i18n, win, now)}</div>
          ))}
          {passed !== null && (
            <div>
              {t("accountUsage.weekPassed", {
                percent: formatNumber(language, Math.round(passed)),
              })}
            </div>
          )}
          {viewer.owner && row.members.length > 0 && (
            <div>
              {t("accountUsage.members", { names: row.members.join(", ") })}
            </div>
          )}
          {row.observedAtMs !== null &&
            now - row.observedAtMs >= ACCOUNT_USAGE_AGE_MS && (
              <div>
                {t("subscription.readingAge", {
                  age: formatTimeUntil(i18n, now - row.observedAtMs),
                })}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// An SVG, not a glyph: Safari draws shape glyphs with the emoji font. Its
// cell stays when the row has no details, so the columns line up.
function Chevron({ open, shown }: { open: boolean; shown: boolean }) {
  return (
    <span aria-hidden style={chevronStyle}>
      {shown && <ChevronIcon open={open} />}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{
        display: "block",
        transform: open ? "rotate(90deg)" : undefined,
      }}
    >
      <path
        d="M3 1.5 7 5 3 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const strong = (chunk: ReactNode) => (
  <strong style={{ fontWeight: 600 }}>{chunk}</strong>
);

// Whose account it is: the office, the viewer ("You") or the members.
function whoLabel(
  row: AccountUsageRowWire,
  viewer: AccountUsageViewer,
  t: I18n["t"],
): string {
  return row.owners
    .map((owner) =>
      owner.kind === "office"
        ? t("accountUsage.office")
        : owner.username === viewer.username
          ? t("common.you")
          : owner.username,
    )
    .join(", ");
}

// A small window's name: the model a weekly window limits ("Fable" from
// "Weekly (Fable)"), else its short tag ("5h"). Both are the provider's.
function miniLabel(win: SubscriptionWindowWire): string {
  if (win.modelFamily !== undefined) {
    const model = /\(([^)]+)\)/.exec(win.label)?.[1];
    if (model) return model;
  }
  return win.shortLabel ?? win.label;
}

// The weekly bar: the used share in the provider's colour, a tick at the
// share of the week that has passed.
function WeekBar({
  used,
  passed,
  rgb,
}: {
  used: number;
  passed: number | null;
  rgb: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        minWidth: 0,
        height: 10,
        borderRadius: 5,
        background: `rgba(${rgb}, 0.16)`,
      }}
    >
      <div
        style={{
          width: `${used}%`,
          height: "100%",
          borderRadius: 5,
          background: `rgb(${rgb})`,
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
            borderRadius: 1,
            background: "var(--text-primary)",
          }}
        />
      )}
    </div>
  );
}

function MiniBar({
  label,
  used,
  rgb,
  language,
  blank,
}: {
  label: string;
  used: number;
  rgb: string;
  language: I18n["language"];
  blank: boolean;
}) {
  const share = Math.max(0, Math.min(100, used));
  return (
    <span style={miniStyle}>
      {label}
      <span
        style={{
          display: "inline-block",
          width: 26,
          height: 4,
          borderRadius: 2,
          background: `rgba(${rgb}, 0.16)`,
        }}
      >
        <span
          style={{
            display: "block",
            width: `${share}%`,
            height: "100%",
            borderRadius: 2,
            background: `rgb(${rgb})`,
          }}
        />
      </span>
      {blank ? BLANK : `${formatNumber(language, Math.round(share))}%`}
    </span>
  );
}

const hint: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  margin: "4px 0 0",
  lineHeight: 1.4,
};

const legendTick: CSSProperties = {
  display: "inline-block",
  width: 2,
  height: 10,
  verticalAlign: -1,
  background: "var(--text-primary)",
};

const sectionLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  margin: "12px 0 0",
};

// The card width (padding in) the one-line grid fits in: its columns and
// gaps, the row's padding and stripe, the card's padding.
const WIDE_MIN_WIDTH = 690;

// A row's grid. Wide: one line, every row's columns aligned (who, weekly
// bar, its numbers, the small bars, the chevron). Narrow: who and the
// chevron, then the weekly bar and its numbers, then the small bars.
const WIDE_GRID = {
  columns: "200px minmax(80px, 1fr) 112px 180px 10px",
  who: "1",
  state: "2 / 5",
  pace: "3",
  minis: "4",
};
const NARROW_GRID = {
  columns: "minmax(0, 1fr) auto 10px",
  who: "1 / 3",
  state: "1 / 4",
  pace: "2 / 4",
  minis: "1 / 4",
};

const lineStyle: CSSProperties = {
  display: "grid",
  alignItems: "center",
  columnGap: 12,
  rowGap: 6,
};

const whoStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const paceStyle: CSSProperties = {
  fontSize: 12,
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
};

const minisStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};

const miniStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
};

const stateStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
};

const chevronStyle: CSSProperties = {
  width: 10,
  fontSize: 11,
  color: "var(--text-muted)",
};

const emailStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const detailsStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  lineHeight: 1.6,
  marginTop: 6,
};

function planPill(rgb: string): CSSProperties {
  return {
    fontSize: 10.5,
    padding: "1px 6px",
    borderRadius: 8,
    marginLeft: 6,
    background: `rgba(${rgb}, 0.16)`,
    color: "var(--text-secondary)",
  };
}
