// Markdown rendering for /isomux-storage (task 1387a9c7) - the chat-facing
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
// Shared with the attachment prompt and the usage report so a size and a
// timestamp read the same everywhere in the product.
import {
  formatSize,
  formatRelativeTime,
  escapeMarkdownTableCellText,
} from "../shared/format-human.ts";

// Reading order and plain-language labels are shared with the owner-only
// storage panel in office settings, so the same bytes are never called two
// different things in chat and in the UI.
import {
  IN_ROOT_ORDER,
  OUT_OF_ROOT_ORDER,
  CATEGORY_LABELS as LABELS,
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

function formatCount(n: number): string {
  return n.toLocaleString();
}

export function renderStorageReport(
  usage: StorageUsageWire,
  opts: StorageReportOptions,
): string {
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
  ).map((id) => LABELS[id].toLowerCase());

  const lines: string[] = [];
  lines.push(`## Isomux storage`);
  lines.push("");
  lines.push(
    outsideBytes > 0
      ? `**${formatSize(totalBytes)} total:** ${formatSize(usage.stateRootBytes)} of office state, plus ${formatSize(outsideBytes)} in ${outsideLabels.join(" and ")}.`
      : `**${formatSize(totalBytes)} total**, all of it office state.`,
  );
  lines.push("");
  lines.push(`_Measured ${formatRelativeTime(usage.measuredAt)}._`);
  lines.push("");

  lines.push(`| Category | Size | Files |`);
  lines.push(`| --- | ---: | ---: |`);
  const row = (id: StorageCategoryId) => {
    const c = byId.get(id);
    // A category the measurement did not return at all can only mean the
    // contract changed underneath this file; skip it rather than print a
    // phantom zero row.
    if (!c) return;
    if (!c.available) {
      lines.push(`| ${LABELS[id]} | none | - |`);
      return;
    }
    lines.push(
      `| ${LABELS[id]} | ${formatSize(c.bytes)} | ${formatCount(c.files)} |`,
    );
  };
  for (const id of IN_ROOT_ORDER) row(id);
  // The in-root categories sum to exactly stateRootBytes (other-state is
  // derived by subtraction), so this subtotal is an identity, not a re-add.
  lines.push(
    `| **Total office state** | **${formatSize(usage.stateRootBytes)}** | |`,
  );
  for (const id of OUT_OF_ROOT_ORDER) row(id);
  lines.push(`| **Total** | **${formatSize(totalBytes)}** | |`);
  lines.push("");
  lines.push(
    `_Backups and update snapshots sit outside the office state directory, so they are listed after its subtotal. "none" means that location isn't set up on this machine._`,
  );

  if (isOwner) {
    const paths = [
      `office state \`${usage.stateRoot}\``,
      ...OUT_OF_ROOT_ORDER.map((id) => {
        const c = byId.get(id);
        const label = LABELS[id].toLowerCase();
        return c?.path ? `${label} \`${c.path}\`` : `${label} (not set up)`;
      }),
    ];
    lines.push("");
    lines.push(`_Locations: ${paths.join(", ")}._`);
  } else {
    // Same reason the route strips this: the per-agent breakdown enumerates
    // log directories for agents in rooms the caller may not be able to see.
    lines.push("");
    lines.push(`_The per-agent breakdown and the paths are owner-only._`);
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
    lines.push(`### Biggest agents`);
    lines.push("");
    lines.push(
      `| Agent | Transcripts | Attachments | Sessions | Last activity |`,
    );
    lines.push(`| --- | ---: | ---: | ---: | --- |`);
    for (const a of shown) {
      const last =
        a.lastActivityAt === null ? "-" : formatRelativeTime(a.lastActivityAt);
      const label = opts.agentLabel(a.agentId);
      // The name is escaped to literal text FIRST, then the "(killed)"
      // annotation is appended - so the only live markdown in the cell is this
      // line's own, and a name reading `Gone _(killed)_` renders as those
      // characters rather than as the report's annotation.
      const name =
        escapeMarkdownTableCellText(label.name) +
        (label.killed ? " _(killed)_" : "");
      lines.push(
        `| ${name} | ${formatSize(a.transcriptBytes)} | ${formatSize(a.attachmentBytes)} | ${formatCount(a.sessions)} | ${last} |`,
      );
    }
    if (sorted.length > shown.length) {
      lines.push("");
      lines.push(
        `_Showing the ${shown.length} largest of ${sorted.length} agents with stored data._`,
      );
    }
  }

  if (isOwner) {
    lines.push("");
    lines.push(
      `_Nothing here is deleted automatically. Transcripts and attachments are only removed when the owner asks for it._`,
    );
  }

  return lines.join("\n");
}
