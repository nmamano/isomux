// Markdown rendering for /isomux-storage - the chat-facing
// view of the same measurement GET /api/storage/usage returns.
//
// PURE. Takes an already-measured StorageUsage plus a name resolver and returns
// message parts; it never stats the disk, so the report can be pinned by a test
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

// Sizes, counts and ages are values each reader words in their language
// (ruling 12; task c37a7365). The report and the storage panel measure the
// same bytes, so they divide by the same 1024 (formatBytes).
import {
  joinLogText,
  msg,
  type LogMessage,
  type LogParam,
  type LogPart,
  type LogText,
} from "../shared/i18n/log-message.ts";
import { keyFrom } from "../shared/i18n/translate.ts";

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

// A value alone, as a part of a line: a size, a count or an age in a cell.
function value(param: LogParam): LogMessage {
  return msg("common.value", { value: param });
}

/**
 * A size a person reads, or the catalog's words for a value that is not a size.
 * formatBytes returns null for that case, so the writer picks the words here
 * and a {bytes} value never carries something that is not a size.
 */
function size(bytes: number): LogMessage {
  return Number.isFinite(bytes) && bytes >= 0
    ? value({ bytes })
    : msg("common.unknownSize");
}

/**
 * Coarse "how long ago" for the report header. Anything older than a week
 * becomes an absolute date - "23d ago" is harder to place than "Jul 8" - which
 * is the rule the hand-built formatter in shared/format-human.ts used before
 * this moved onto Intl. Decided when the report is written, and frozen there.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function measuredAge(ts: number): LogParam {
  const ago = Date.now() - ts;
  if (ago >= WEEK_MS) return { time: ts, shape: "monthDay" };
  return { elapsed: Math.max(0, ago) };
}

export function renderStorageReport(
  usage: StorageUsageWire,
  opts: StorageReportOptions,
): LogPart[] {
  // Own-property lookup like every other key table, so a category id that is
  // not one cannot reach msg() with something inherited from Object.prototype.
  const label = (id: StorageCategoryId): LogText => {
    const key = keyFrom(CATEGORY_KEYS, id);
    return key ? msg(key) : id;
  };
  // The label lowercased in the reader's language, for use inside a sentence:
  // as a value, and as a part of a line.
  const lowerParam = (id: StorageCategoryId): LogParam => {
    const key = keyFrom(CATEGORY_KEYS, id);
    return key ? { lower: msg(key) } : id.toLowerCase();
  };
  const lowerLabel = (id: StorageCategoryId): LogPart => {
    const param = lowerParam(id);
    return typeof param === "string" ? param : value(param);
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
  const outsideLabels: LogPart[] = [];
  for (const id of OUT_OF_ROOT_ORDER) {
    if ((byId.get(id)?.bytes ?? 0) <= 0) continue;
    if (outsideLabels.length > 0)
      outsideLabels.push(msg("storageReport.locationsJoin"));
    outsideLabels.push(lowerLabel(id));
  }

  const lines: LogText[] = [];
  lines.push(["## ", msg("storageReport.heading")]);
  lines.push("");
  lines.push(
    outsideBytes > 0
      ? msg("storageReport.totalWithOutside", {
          total: size(totalBytes),
          stateRoot: size(usage.stateRootBytes),
          outside: size(outsideBytes),
          locations: { parts: outsideLabels },
        })
      : msg("storageReport.totalOnly", { total: size(totalBytes) }),
  );
  lines.push("");
  lines.push(
    msg("storageReport.measured", { age: measuredAge(usage.measuredAt) }),
  );
  lines.push("");

  lines.push([
    "| ",
    msg("storageReport.columnCategory"),
    " | ",
    msg("storageReport.columnSize"),
    " | ",
    msg("storageReport.columnFiles"),
    " |",
  ]);
  lines.push(`| --- | ---: | ---: |`);
  const row = (id: StorageCategoryId) => {
    const c = byId.get(id);
    // A category the measurement did not return at all can only mean the
    // contract changed underneath this file; skip it rather than print a
    // phantom zero row.
    if (!c) return;
    if (!c.available) {
      lines.push(
        joinLogText([
          "| ",
          label(id),
          " | ",
          msg("storageReport.none"),
          " | - |",
        ]),
      );
      return;
    }
    lines.push(
      joinLogText([
        "| ",
        label(id),
        " | ",
        size(c.bytes),
        " | ",
        value({ number: c.files }),
        " |",
      ]),
    );
  };
  for (const id of IN_ROOT_ORDER) row(id);
  // The in-root categories sum to exactly stateRootBytes (other-state is
  // derived by subtraction), so this subtotal is an identity, not a re-add.
  lines.push([
    "| **",
    msg("storageReport.totalOfficeState"),
    "** | **",
    size(usage.stateRootBytes),
    "** | |",
  ]);
  for (const id of OUT_OF_ROOT_ORDER) row(id);
  lines.push([
    "| **",
    msg("storageReport.total"),
    "** | **",
    size(totalBytes),
    "** | |",
  ]);
  lines.push("");
  lines.push(msg("storageReport.outsideNote"));

  if (isOwner) {
    const paths: LogText[] = [
      [msg("storageReport.locationOfficeState"), ` \`${usage.stateRoot}\``],
      ...OUT_OF_ROOT_ORDER.map((id): LogText => {
        const c = byId.get(id);
        return c?.path
          ? [lowerLabel(id), ` \`${c.path}\``]
          : msg("storageReport.locationNotSetUp", { label: lowerParam(id) });
      }),
    ];
    lines.push("");
    lines.push(
      msg("storageReport.locations", {
        paths: { parts: joinLogText(paths, ", ") },
      }),
    );
  } else {
    // Same reason the route strips this: the per-agent breakdown enumerates
    // log directories for agents in rooms the caller may not be able to see.
    lines.push("");
    lines.push(msg("storageReport.ownerOnly"));
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
    lines.push(["### ", msg("storageReport.biggestAgents")]);
    lines.push("");
    lines.push([
      "| ",
      msg("storageReport.columnAgent"),
      " | ",
      msg("storageReport.columnTranscripts"),
      " | ",
      msg("storageReport.columnAttachments"),
      " | ",
      msg("storageReport.columnSessions"),
      " | ",
      msg("storageReport.columnLastActivity"),
      " |",
    ]);
    lines.push(`| --- | ---: | ---: | ---: | --- |`);
    for (const a of shown) {
      const last: LogText =
        a.lastActivityAt === null ? "-" : value(measuredAge(a.lastActivityAt));
      const agent = opts.agentLabel(a.agentId);
      // The name is escaped to literal text FIRST, then the "(killed)"
      // annotation is appended - so the only live markdown in the cell is this
      // line's own, and a name reading `Gone _(killed)_` renders as those
      // characters rather than as the report's annotation.
      const name = joinLogText([
        escapeMarkdownTableCellText(agent.name),
        agent.killed ? [" ", msg("storageReport.killed")] : "",
      ]);
      lines.push(
        joinLogText([
          "| ",
          name,
          " | ",
          size(a.transcriptBytes),
          " | ",
          size(a.attachmentBytes),
          " | ",
          value({ number: a.sessions }),
          " | ",
          last,
          " |",
        ]),
      );
    }
    if (sorted.length > shown.length) {
      lines.push("");
      lines.push(
        msg("storageReport.showing", {
          shown: { number: shown.length },
          total: { number: sorted.length },
        }),
      );
    }
  }

  if (isOwner) {
    lines.push("");
    lines.push(msg("storageReport.nothingDeleted"));
  }

  return joinLogText(lines, "\n");
}
