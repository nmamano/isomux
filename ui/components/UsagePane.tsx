import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { Translator } from "../../shared/i18n/translate.ts";
import {
  formatDecimal,
  formatMoneyUSD,
  formatNumber,
} from "../../shared/i18n/number.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import type {
  UsageBucketWire,
  UsageReportWire,
} from "../../shared/contract-shapes.ts";
import { noTranslate } from "../no-translate.ts";
import { useAppState } from "../store.tsx";
import { getUsageLayout, setUsageLayout } from "../device-settings.ts";

// Keeps a held cell at its height: an empty element collapses.
const BLANK = "\u00a0";

// Not components, so the language arrives as an argument (ruling 18). k and M
// are magnitude symbols and stay as they are (ruling 11); the number in front
// of each one is a number like any other, so it takes the reader's marks.
function tokenCount(language: SupportedLanguageCode, n: number): string {
  if (n === 0) return "-";
  if (n >= 999_500) return `${formatDecimal(language, n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${formatDecimal(language, n / 1_000, 0)}k`;
  return formatNumber(language, n);
}

function inputCount(
  language: SupportedLanguageCode,
  bucket: UsageBucketWire,
  t: Translator["t"],
): string {
  if (bucket.totalIn === 0) return "-";
  const cacheable = bucket.cacheRead + bucket.cacheCreation;
  if (cacheable === 0) return tokenCount(language, bucket.totalIn);
  const hit = Math.round((bucket.cacheRead / cacheable) * 100);
  return hit < 80
    ? t("settings.usage.cacheHit", {
        count: tokenCount(language, bucket.totalIn),
        hit,
      })
    : tokenCount(language, bucket.totalIn);
}

// Isomux reports its spend in US dollars whoever is reading, so the currency
// is fixed and only its rendering moves. A hard "$" in front of the number is
// English typography, not a symbol like k or M.
function dollars(language: SupportedLanguageCode, n: number): string {
  if (n === 0) return "-";
  return n >= 100
    ? formatMoneyUSD(language, n, 0)
    : formatMoneyUSD(language, n, 2);
}

// Token and cost totals for the office. Read-only, so no guard and no
// footer: the sidebar is the way out.
export function UsagePane() {
  const { t } = useI18n();
  const { agents, rooms, sessionContext } = useAppState();
  const [usage, setUsage] = useState<UsageReportWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Until the report answers, the tables are drawn with blank rows, as many
  // as this device saw last, or as the reader sees in the office on a first
  // visit (task 3755fad4).
  const [held] = useState(() =>
    getUsageLayout({
      agents: agents.length,
      rooms: rooms.length,
      schedules: 0,
    }),
  );
  // The server scopes the report for everyone but an owner.
  const scoped = usage ? usage.scoped : sessionContext?.role !== "owner";

  useEffect(() => {
    apiFetch<UsageReportWire>("GET", "/api/usage")
      .then((report) => {
        setUsageLayout({
          agents: report.agents.length,
          rooms: report.rooms.length,
          schedules: report.cronjobs?.length ?? 0,
        });
        setUsage(report);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError ? e.message : t("settings.usage.loadFailed"),
        ),
      );
    // t follows the language; the report itself does not, so load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blankRows = (n: number, prefix: string): UsageRow[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `${prefix}${i}`,
      // The first row says the report is loading; an empty table would read
      // as no usage.
      label: i === 0 ? t("common.loading") : BLANK,
      loading: i === 0,
      session: null,
      lifetime: null,
    }));

  return (
    <div style={{ marginTop: 24 }} aria-busy={(!usage && !error) || undefined}>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
        {t("settings.usage.title")}
      </h3>
      <p
        style={{
          fontSize: 11,
          color: "var(--text-ghost)",
          lineHeight: 1.5,
        }}
      >
        {t("settings.usage.intro")}
      </p>
      {scoped && (
        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {t("settings.usage.scoped")}
        </p>
      )}
      {error ? (
        <p style={{ color: "var(--red-text)", fontSize: 11 }}>{error}</p>
      ) : (
        <>
          <UsageTable
            title={t("settings.usage.agents")}
            firstHeader={t("common.agent")}
            rows={
              !usage
                ? blankRows(held.agents, "agent")
                : usage.agents.map((row) => ({
                    key: row.id,
                    label: row.name,
                    detail: row.roomName,
                    session: row.session,
                    lifetime: row.lifetime,
                    identityData: true,
                  }))
            }
          />
          <UsageTable
            title={t("settings.usage.rooms")}
            note={t("settings.usage.roomsNote")}
            firstHeader={t("settings.usage.roomColumn")}
            rows={
              !usage
                ? blankRows(held.rooms, "room")
                : usage.rooms.map((row) => ({
                    key: row.id,
                    label: row.name,
                    detail: row.deleted
                      ? t("settings.usage.deleted")
                      : undefined,
                    session: row.session,
                    lifetime: row.lifetime,
                    identityData: true,
                  }))
            }
          />
          {(usage ? (usage.cronjobs?.length ?? 0) : held.schedules) > 0 && (
            <LifetimeTable
              title={t("settings.usage.schedules")}
              rows={
                !usage
                  ? blankRows(held.schedules, "schedule")
                  : (usage.cronjobs ?? []).map((row) => ({
                      key: row.id,
                      label: row.name,
                      detail: row.deleted
                        ? t("settings.usage.deleted")
                        : undefined,
                      lifetime: row.lifetime,
                    }))
              }
            />
          )}
          <UsageTable
            title={
              scoped
                ? t("settings.usage.total")
                : t("settings.usage.officeTotal")
            }
            firstHeader=""
            rows={[
              {
                key: "total",
                label: t("settings.usage.total"),
                session: usage ? usage.total.session : null,
                lifetime: usage ? usage.total.lifetime : null,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

type UsageRow = {
  key: string;
  label: string;
  detail?: string;
  // The loading cue in a held table, in place of a name.
  loading?: boolean;
  // null while the report loads: the cells are blank.
  session: UsageBucketWire | null;
  lifetime: UsageBucketWire | null;
  identityData?: boolean;
};

function UsageTable({
  title,
  note,
  firstHeader,
  rows,
}: {
  title: string;
  note?: string;
  firstHeader: string;
  rows: UsageRow[];
}) {
  const { t } = useI18n();
  return (
    <section style={{ marginTop: 22 }}>
      <h4 style={heading}>{title}</h4>
      {note && <p style={noteStyle}>{note}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={leftHead}>{firstHeader}</th>
              <th style={head}>{t("settings.usage.inSession")}</th>
              <th style={head}>{t("settings.usage.outSession")}</th>
              <th style={head}>{t("settings.usage.costSession")}</th>
              <th style={head}>{t("settings.usage.inLifetime")}</th>
              <th style={head}>{t("settings.usage.outLifetime")}</th>
              <th style={head}>{t("settings.usage.costLifetime")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td
                  {...(row.identityData ? noTranslate() : {})}
                  style={leftCell}
                >
                  <RowLabel row={row} />
                </td>
                <BucketCells bucket={row.session} />
                <BucketCells bucket={row.lifetime} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LifetimeTable({
  title,
  rows,
}: {
  title: string;
  rows: Omit<UsageRow, "session">[];
}) {
  const { t } = useI18n();
  return (
    <section style={{ marginTop: 22 }}>
      <h4 style={heading}>{title}</h4>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={leftHead}>{t("common.schedule")}</th>
              <th style={head}>{t("settings.usage.inLifetime")}</th>
              <th style={head}>{t("settings.usage.outLifetime")}</th>
              <th style={head}>{t("settings.usage.costLifetime")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td style={leftCell}>
                  <RowLabel row={row} />
                </td>
                <BucketCells bucket={row.lifetime} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RowLabel({
  row,
}: {
  row: Pick<UsageRow, "label" | "detail" | "loading">;
}) {
  if (row.loading) return <span style={detailStyle}>{row.label}</span>;
  return (
    <>
      <strong>{row.label}</strong>
      {row.detail && <span style={detailStyle}> {row.detail}</span>}
    </>
  );
}

function BucketCells({ bucket }: { bucket: UsageBucketWire | null }) {
  const { t, language } = useI18n();
  if (!bucket)
    return (
      <>
        <td style={cell}>{BLANK}</td>
        <td style={cell}>{BLANK}</td>
        <td style={cell}>{BLANK}</td>
      </>
    );
  return (
    <>
      <td style={cell}>{inputCount(language, bucket, t)}</td>
      <td style={cell}>{tokenCount(language, bucket.totalOut)}</td>
      <td style={cell}>{dollars(language, bucket.costUSD)}</td>
    </>
  );
}

const heading = {
  margin: "0 0 8px",
  fontSize: 12,
  color: "var(--text-secondary)",
};
const noteStyle = {
  margin: "-3px 0 8px",
  fontSize: 10,
  color: "var(--text-ghost)",
};
const tableStyle = {
  width: "100%",
  minWidth: 650,
  borderCollapse: "collapse" as const,
  fontSize: 10,
};
const leftHead = {
  padding: "7px 8px",
  textAlign: "left" as const,
  color: "var(--text-ghost)",
  borderBottom: "1px solid var(--border)",
};
const head = {
  ...leftHead,
  textAlign: "right" as const,
  whiteSpace: "nowrap" as const,
};
const leftCell = {
  padding: "7px 8px",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
  whiteSpace: "nowrap" as const,
};
const cell = { ...leftCell, textAlign: "right" as const };
const detailStyle = { color: "var(--text-ghost)", fontWeight: 400 };
