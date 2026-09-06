// Markdown rendering for /isomux-storage - the chat-facing
// view of the same measurement GET /api/storage/usage returns.
//
// PURE. Takes an already-measured StorageUsage plus a name resolver and returns
// a string; it never stats the disk, so the report can be pinned by a test
// without a fixture tree (server/storage-usage.test.ts already owns the
// measuring). Everything the report knows about access control arrives in the
// StorageUsage it is handed: the caller passes the full measurement for the
// office owner and the aggregateOnly() projection for everybody else, exactly
// like the route does. `stateRoot === null` IS the "not the owner" signal.
//
// READ-ONLY reporting. Pruning is a separate, owner-only, POST-only surface.

import type {
  StorageCategoryId,
  StorageUsageWire,
} from "../shared/contract-shapes.ts";
// Shared with the attachment prompt so an agent-facing size reads the same.
import { escapeMarkdownTableCellText } from "../shared/format-human.ts";

// Sizes, counts and ages in the reader's language (ruling 12). The report and
// the storage panel measure the same bytes, so they divide by the same 1024.
import { formatBytes, formatNumber } from "../shared/i18n/number.ts";
import { formatDateTime, timeSince } from "../shared/i18n/time.ts";
import { keyFrom } from "../shared/i18n/translate.ts";
import type { Translator } from "../shared/i18n/translate.ts";

// Reading order and the category key table are shared with the owner-only
// storage panel in office settings, so the same bytes are never called two
// different things in chat and in the UI.
import {
  IN_ROOT_ORDER,
  OUT_OF_ROOT_ORDER,
  CATEGORY_KEYS,
} from "../shared/storage-labels.ts";

// Only the largest handful of agents are worth a table row; the tail is a long
// list of near-zero directories. The count that was dropped is always stated -
// a truncated table that looks complete is worse than no table.
const AGENT_ROWS = 10;

// What the caller knows about an agent behind a stored log directory. The name
// is RAW - the renderer escapes it to literal text - and `killed` is a flag
// rather than text the caller appends, so the only live markdown in a table
// cell is markdown this file wrote. An agent name is user-controlled: it can
// carry a pipe, a newline, or a convincing forgery of the annotation itself.
export interface AgentLabel {
  name: string;
  killed?: boolean;
}

export interface StorageReportOptions {
  // Live agents resolve by id; killed agents come from agent history; anything
  // unrecognized falls back to the raw directory name so a row is never
  // nameless.
  agentLabel: (agentId: string) => AgentLabel;
}

/**
 * A size a person reads, or the catalog's words for a value that is not a size.
 * formatBytes returns null for that case rather than inventing a reading.
 */
function size(i18n: Translator, bytes: number): string {
  return (
    formatBytes(i18n.language, bytes) ?? i18n.t("storageReport.unknownSize")
  );
}

/**
 * Coarse "how long ago" for the report header. Anything older than a week
 * becomes an absolute date - "23d ago" is harder to place than "Jul 8" - which
 * is the rule the hand-built formatter in shared/format-human.ts used before
 * this moved onto Intl.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function measuredAge(i18n: Translator, ts: number): string {
  if (Date.now() - ts >= WEEK_MS)
    return formatDateTime(i18n.language, ts, "monthDay");
  const since = timeSince(i18n.language, ts);
  return since.kind === "now" ? i18n.t("common.justNow") : since.text;
}

export function renderStorageReport(
  i18n: Translator,
  usage: StorageUsageWire,
  opts: StorageReportOptions,
): string {
  const { t, language } = i18n;
  // Own-property lookup like every other key table, so a category id that is
  // not one cannot reach t() with something inherited from Object.prototype.
  const label = (id: StorageCategoryId) => {
    const key = keyFrom(CATEGORY_KEYS, id);
    return key ? t(key) : id;
  };
  // The owner gets paths and the per-agent breakdown; everyone else got the
  // aggregateOnly() projection, whose tell is a nulled state root.
  const isOwner = usage.stateRoot !== null;
  const byId = new Map(usage.categories.map((c) => [c.id, c] as const));

  const outsideBytes = OUT_OF_ROOT_ORDER.reduce(
    (sum, id) => sum + (byId.get(id)?.bytes ?? 0),
    0,
  );
  const totalBytes = usage.stateRootBytes + outsideBytes;
  // Name only the out-of-root locations this box actually has, so the headline
  // never credits bytes to update snapshots on a machine that has none.
  const outsideLabels = OUT_OF_ROOT_ORDER.filter(
    (id) => (byId.get(id)?.bytes ?? 0) > 0,
  ).map((id) => label(id).toLowerCase());

  const lines: string[] = [];
  lines.push(`## ${t("storageReport.heading")}`);
  lines.push("");
  lines.push(
    outsideBytes > 0
      ? t("storageReport.totalWithOutside", {
          total: size(i18n, totalBytes),
          stateRoot: size(i18n, usage.stateRootBytes),
          outside: size(i18n, outsideBytes),
          locations: outsideLabels.join(t("storageReport.locationsJoin")),
        })
      : t("storageReport.totalOnly", { total: size(i18n, totalBytes) }),
  );
  lines.push("");
  lines.push(
    t("storageReport.measured", { age: measuredAge(i18n, usage.measuredAt) }),
  );
  lines.push("");

  lines.push(
    `| ${t("storageReport.columnCategory")} | ${t("storageReport.columnSize")} | ${t("storageReport.columnFiles")} |`,
  );
  lines.push(`| --- | ---: | ---: |`);
  const row = (id: StorageCategoryId) => {
    const c = byId.get(id);
    // A category the measurement did not return at all can only mean the
    // contract changed underneath this file; skip it rather than print a
    // phantom zero row.
    if (!c) return;
    if (!c.available) {
      lines.push(`| ${label(id)} | ${t("storageReport.none")} | - |`);
      return;
    }
    lines.push(
      `| ${label(id)} | ${size(i18n, c.bytes)} | ${formatNumber(language, c.files)} |`,
    );
  };
  for (const id of IN_ROOT_ORDER) row(id);
  // The in-root categories sum to exactly stateRootBytes (other-state is
  // derived by subtraction), so this subtotal is an identity, not a re-add.
  lines.push(
    `| **${t("storageReport.totalOfficeState")}** | **${size(i18n, usage.stateRootBytes)}** | |`,
  );
  for (const id of OUT_OF_ROOT_ORDER) row(id);
  lines.push(
    `| **${t("storageReport.total")}** | **${size(i18n, totalBytes)}** | |`,
  );
  lines.push("");
  lines.push(t("storageReport.outsideNote"));

  if (isOwner) {
    const paths = [
      `${t("storageReport.locationOfficeState")} \`${usage.stateRoot}\``,
      ...OUT_OF_ROOT_ORDER.map((id) => {
        const c = byId.get(id);
        const name = label(id).toLowerCase();
        return c?.path
          ? `${name} \`${c.path}\``
          : t("storageReport.locationNotSetUp", { label: name });
      }),
    ];
    lines.push("");
    lines.push(t("storageReport.locations", { paths: paths.join(", ") }));
  } else {
    // Same reason the route strips this: the per-agent breakdown enumerates
    // log directories for agents in rooms the caller may not be able to see.
    lines.push("");
    lines.push(t("storageReport.ownerOnly"));
  }

  if (isOwner && usage.agents.length > 0) {
    const sorted = [...usage.agents].sort(
      (a, b) =>
        b.transcriptBytes +
        b.attachmentBytes -
        (a.transcriptBytes + a.attachmentBytes),
    );
    const shown = sorted.slice(0, AGENT_ROWS);
    lines.push("");
    lines.push(`### ${t("storageReport.biggestAgents")}`);
    lines.push("");
    lines.push(
      `| ${t("storageReport.columnAgent")} | ${t("storageReport.columnTranscripts")} | ${t("storageReport.columnAttachments")} | ${t("storageReport.columnSessions")} | ${t("storageReport.columnLastActivity")} |`,
    );
    lines.push(`| --- | ---: | ---: | ---: | --- |`);
    for (const a of shown) {
      const last =
        a.lastActivityAt === null ? "-" : measuredAge(i18n, a.lastActivityAt);
      const agent = opts.agentLabel(a.agentId);
      // The name is escaped to literal text FIRST, then the "(killed)"
      // annotation is appended - so the only live markdown in the cell is this
      // line's own, and a name reading `Gone _(killed)_` renders as those
      // characters rather than as the report's annotation.
      const name =
        escapeMarkdownTableCellText(agent.name) +
        (agent.killed ? ` ${t("storageReport.killed")}` : "");
      lines.push(
        `| ${name} | ${size(i18n, a.transcriptBytes)} | ${size(i18n, a.attachmentBytes)} | ${formatNumber(language, a.sessions)} | ${last} |`,
      );
    }
    if (sorted.length > shown.length) {
      lines.push("");
      lines.push(
        t("storageReport.showing", {
          shown: formatNumber(language, shown.length),
          total: formatNumber(language, sorted.length),
        }),
      );
    }
  }

  if (isOwner) {
    lines.push("");
    lines.push(t("storageReport.nothingDeleted"));
  }

  return lines.join("\n");
}
