import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFileSummary, DiffPayload } from "../../shared/types.ts";
import { DiffRenderer, type DiffOutputFormat } from "./DiffRenderer.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { useI18n } from "../i18n.tsx";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";

const PREF_KEY = "isomux:diff:outputFormat";
const INLINE_LINES_THRESHOLD = 200;

function readPref(): DiffOutputFormat {
  if (typeof localStorage === "undefined") return "line-by-line";
  const v = localStorage.getItem(PREF_KEY);
  return v === "side-by-side" ? "side-by-side" : "line-by-line";
}

function writePref(v: DiffOutputFormat) {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* quota / private mode */
  }
}

// Split a multi-file unified patch by `diff --git` boundaries. Path is read
// from the chunk's body (`+++ b/...` for adds/mods/renames-with-content,
// `rename to ...` for pure renames, `--- a/...` for deletions) which is much
// more reliable than parsing the `diff --git a/X b/Y` header - that line is
// ambiguous when paths contain spaces or " b/" substrings.
function splitPatchByFile(patchText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!patchText) return map;
  const lines = patchText.split("\n");
  let currentLines: string[] = [];
  const flush = () => {
    if (currentLines.length === 0) return;
    let plusBPath: string | null = null;
    let dashAPath: string | null = null;
    let renameToPath: string | null = null;
    let isDeletion = false;
    for (const l of currentLines) {
      if (l.startsWith("+++ /dev/null")) isDeletion = true;
      else if (plusBPath === null && l.startsWith("+++ b/"))
        plusBPath = l.slice(6);
      else if (dashAPath === null && l.startsWith("--- a/"))
        dashAPath = l.slice(6);
      else if (renameToPath === null && l.startsWith("rename to "))
        renameToPath = l.slice(10);
    }
    const path = plusBPath ?? renameToPath ?? (isDeletion ? dashAPath : null);
    if (path !== null) map.set(path, currentLines.join("\n"));
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentLines = [line];
    } else if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }
  flush();
  return map;
}

function StatusBadge({ status }: { status: DiffFileSummary["status"] }) {
  const { t } = useI18n();
  const palette: Record<
    DiffFileSummary["status"],
    { fg: string; bg: string; labelKey: PlainMessageKey }
  > = {
    added: {
      fg: "var(--green)",
      bg: "var(--green-bg)",
      labelKey: "cards.diff.status.added",
    },
    modified: {
      fg: "var(--accent)",
      bg: "var(--accent-bg)",
      labelKey: "common.modified",
    },
    deleted: {
      fg: "var(--red)",
      bg: "var(--red-bg)",
      labelKey: "cards.diff.status.deleted",
    },
    renamed: {
      fg: "var(--purple)",
      bg: "rgba(155,109,255,0.10)",
      labelKey: "cards.diff.status.renamed",
    },
    copied: {
      fg: "var(--purple)",
      bg: "rgba(155,109,255,0.10)",
      labelKey: "cards.diff.status.copied",
    },
    untracked: {
      fg: "var(--orange)",
      bg: "var(--orange-bg)",
      labelKey: "cards.diff.status.untracked",
    },
    binary: {
      fg: "var(--text-muted)",
      bg: "var(--bg-hover)",
      labelKey: "cards.diff.status.binary",
    },
  };
  const p = palette[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        background: p.bg,
        color: p.fg,
        fontSize: 10,
        fontFamily: "'JetBrains Mono',monospace",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        flexShrink: 0,
      }}
    >
      {t(p.labelKey)}
    </span>
  );
}

function PlusMinus({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {additions > 0 && (
        <span style={{ color: "var(--green)" }}>+{additions}</span>
      )}
      {deletions > 0 && (
        <span style={{ color: "var(--red)" }}>-{deletions}</span>
      )}
    </span>
  );
}

function FilePath({ summary }: { summary: DiffFileSummary }) {
  if (summary.oldPath && summary.oldPath !== summary.path) {
    return (
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>{summary.oldPath}</span>
        <span style={{ color: "var(--text-faint)", margin: "0 6px" }}>→</span>
        <span>{summary.path}</span>
      </span>
    );
  }
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {summary.path}
    </span>
  );
}

function DiffOverlay({
  summary,
  patch,
  outputFormat,
  truncated,
  onClose,
}: {
  summary: DiffFileSummary;
  patch: string | null;
  outputFormat: DiffOutputFormat;
  truncated: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Intercept ESC at capture phase so the global window-level handler in
  // App.tsx (which navigates back to the room view) doesn't fire.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  const reason = truncated
    ? t("cards.diff.reasonTruncated")
    : summary.status === "binary"
      ? t("cards.diff.reasonBinary")
      : summary.status === "untracked"
        ? t("cards.diff.reasonUntracked")
        : !patch
          ? t("cards.diff.reasonNoPatch")
          : null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "default",
      }}
    >
      <div
        style={{
          width: "min(95vw, 1400px)",
          height: "min(92vh, 1000px)",
          background: "var(--bg-surface-solid)",
          border: "1px solid var(--border-medium)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--bg-overlay-solid)",
          }}
        >
          <StatusBadge status={summary.status} />
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 13,
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            <FilePath summary={summary} />
          </span>
          <PlusMinus
            additions={summary.additions}
            deletions={summary.deletions}
          />
          {patch && <CopyButton getText={() => patch} />}
          <button
            onClick={onClose}
            title={t("cards.diff.closeHint")}
            style={{
              background: "transparent",
              border: "1px solid var(--border-medium)",
              color: "var(--text-dim)",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
              fontFamily: "'DM Sans',sans-serif",
              cursor: "pointer",
            }}
          >
            {t("common.close")}
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {reason && (
            <div
              style={{
                padding: "12px 16px",
                color: "var(--text-dim)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 13,
                background: "var(--bg-subtle)",
                border: "1px dashed var(--border-medium)",
                borderRadius: 8,
              }}
            >
              {reason}
            </div>
          )}
          {!reason && patch && (
            <DiffRenderer patchText={patch} outputFormat={outputFormat} />
          )}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  summary,
  patch,
  outputFormat,
  expanded,
  onToggle,
  onOverlay,
  truncated,
}: {
  summary: DiffFileSummary;
  patch: string | null;
  outputFormat: DiffOutputFormat;
  expanded: boolean;
  onToggle: () => void;
  onOverlay: () => void;
  truncated: boolean;
}) {
  const { t } = useI18n();
  const handleClick = summary.inlineEligible ? onToggle : onOverlay;
  const overlayHint = !summary.inlineEligible
    ? truncated
      ? t("cards.diff.openTruncated")
      : summary.status === "binary"
        ? t("cards.diff.openBinary")
        : summary.status === "untracked"
          ? t("cards.diff.openUntracked")
          : t("cards.diff.openLines", { lines: summary.lineCount })
    : null;

  return (
    <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <button
        onClick={handleClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "8px 12px",
          border: "none",
          background: "transparent",
          color: "var(--text-secondary)",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 12,
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {summary.inlineEligible ? (
          <span
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
              display: "inline-block",
              fontSize: 8,
              color: "var(--text-faint)",
              flexShrink: 0,
            }}
          >
            &#9654;
          </span>
        ) : (
          <span
            style={{
              width: 8,
              color: "var(--text-faint)",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            &#x29C9;
          </span>
        )}
        <StatusBadge status={summary.status} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <FilePath summary={summary} />
        </span>
        <PlusMinus
          additions={summary.additions}
          deletions={summary.deletions}
        />
        {overlayHint && (
          <span
            style={{ color: "var(--text-faint)", fontSize: 10, flexShrink: 0 }}
          >
            {overlayHint}
          </span>
        )}
      </button>
      {summary.inlineEligible && expanded && patch && (
        <div style={{ padding: "0 12px 10px 28px", overflowX: "auto" }}>
          <DiffRenderer patchText={patch} outputFormat={outputFormat} />
        </div>
      )}
    </div>
  );
}

export function DiffCard({ payload }: { payload: DiffPayload }) {
  const { t, tn } = useI18n();
  const [outputFormat, setOutputFormat] = useState<DiffOutputFormat>(() =>
    readPref(),
  );
  const setFormat = useCallback((v: DiffOutputFormat) => {
    setOutputFormat(v);
    writePref(v);
  }, []);

  const perFilePatch = useMemo(
    () => splitPatchByFile(payload.patchText ?? ""),
    [payload.patchText],
  );

  const inlineLineTotal = useMemo(
    () =>
      payload.files
        .filter((f) => f.inlineEligible)
        .reduce((sum, f) => sum + f.lineCount, 0),
    [payload.files],
  );
  const defaultExpanded = inlineLineTotal < INLINE_LINES_THRESHOLD;

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const f of payload.files)
      if (f.inlineEligible) seed[f.path] = defaultExpanded;
    return seed;
  });

  const allExpanded = useMemo(
    () =>
      payload.files
        .filter((f) => f.inlineEligible)
        .every((f) => expanded[f.path]),
    [payload.files, expanded],
  );

  const toggleAll = useCallback(() => {
    const target = !allExpanded;
    const next: Record<string, boolean> = {};
    for (const f of payload.files) if (f.inlineEligible) next[f.path] = target;
    setExpanded(next);
  }, [payload.files, allExpanded]);

  const toggleFile = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const [overlayPath, setOverlayPath] = useState<string | null>(null);
  const overlaySummary = overlayPath
    ? (payload.files.find((f) => f.path === overlayPath) ?? null)
    : null;

  const headerLine = t("cards.diff.headerLine", {
    additions: payload.stats.additions,
    deletions: payload.stats.deletions,
    files: tn("cards.diff.fileCount", payload.stats.filesChanged),
  });

  return (
    <div
      style={{
        margin: "8px 0",
        borderRadius: 10,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: "var(--bg-overlay-solid)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            fontWeight: 600,
          }}
        >
          {headerLine}
        </span>
        {(payload.branch || payload.head || payload.subject) && (
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            {payload.subject
              ? payload.head
                ? `${payload.subject} · ${payload.head}`
                : payload.subject
              : payload.branch
                ? `${payload.branch} · ${payload.head ?? " - "}`
                : payload.head}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            border: "1px solid var(--border-medium)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {(["line-by-line", "side-by-side"] as const).map((fmt) => {
            const active = outputFormat === fmt;
            return (
              <button
                key={fmt}
                onClick={() => setFormat(fmt)}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: active ? "var(--accent-bg)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 11,
                  fontFamily: "'DM Sans',sans-serif",
                  fontWeight: 600,
                }}
              >
                {fmt === "line-by-line"
                  ? t("cards.diff.unified")
                  : t("cards.diff.split")}
              </button>
            );
          })}
        </span>
        {payload.files.some((f) => f.inlineEligible) && (
          <button
            onClick={toggleAll}
            style={{
              padding: "3px 10px",
              border: "1px solid var(--border-medium)",
              background: "transparent",
              color: "var(--text-dim)",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "'DM Sans',sans-serif",
              cursor: "pointer",
            }}
          >
            {allExpanded
              ? t("cards.diff.collapseAll")
              : t("cards.diff.expandAll")}
          </button>
        )}
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11,
            color: "var(--text-faint)",
            flexBasis: "100%",
            marginTop: -2,
          }}
        >
          {payload.cwd}
          {payload.truncated && (
            <span style={{ color: "var(--orange)", marginLeft: 8 }}>
              {t("cards.diff.summaryOnly")}
            </span>
          )}
        </span>
      </div>
      <div>
        {payload.files.map((f) => (
          <FileRow
            key={f.path}
            summary={f}
            patch={perFilePatch.get(f.path) ?? null}
            outputFormat={outputFormat}
            expanded={!!expanded[f.path]}
            onToggle={() => toggleFile(f.path)}
            onOverlay={() => setOverlayPath(f.path)}
            truncated={payload.truncated}
          />
        ))}
      </div>
      {overlaySummary && (
        <DiffOverlay
          summary={overlaySummary}
          patch={perFilePatch.get(overlaySummary.path) ?? null}
          outputFormat={outputFormat}
          truncated={payload.truncated}
          onClose={() => setOverlayPath(null)}
        />
      )}
    </div>
  );
}
