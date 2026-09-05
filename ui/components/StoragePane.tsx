// Owner-only storage panel - the human surface over the two
// storage routes that shipped headless: GET /api/storage/usage and POST
// /api/storage/prune. Opened from Office Settings; the office owner is the only
// caller who ever sees the entry point.
//
// The panel is a ONE-OFF operation, deliberately: no schedules,
// no automation, no hint of either - Isomux has no retention scheduler and the
// copy must not imply one. Everything here happens because someone pressed a
// button, once.
//
// The delete flow is gated on purpose: a dry-run preview is mandatory before
// the delete button exists at all, editing any field throws the preview away,
// and the final step asks for the word DELETE to be typed. Underneath those,
// the load-bearing rule is that the DELETE request is built from the PLAN the
// user was shown (see ../storage-prune-form.ts), never re-read from the form -
// so racing the controls cannot produce a delete that differs from the thing
// that was confirmed. The server is gated independently - officeOwner on the
// route, dry run unless the body says apply:true - so none of this is the only
// thing standing between a stray click and a deletion.

import { useState, useEffect, useCallback, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import {
  previewRequest,
  applyRequest,
  planMatchesForm,
  type PolicyForm,
} from "../storage-prune-form.ts";
import { formatSize, formatRelativeTime } from "../../shared/format-human.ts";
import {
  IN_ROOT_ORDER,
  OUT_OF_ROOT_ORDER,
  CATEGORY_LABELS,
} from "../../shared/storage-labels.ts";
import type {
  StorageUsageWire,
  StorageCategoryWire,
  PrunePlanWire,
  PruneResultWire,
  PruneSkipReason,
  PruneTarget,
  StoragePruneRes,
} from "../../shared/contract-shapes.ts";
import type { BackupStatusWire } from "../../shared/contract-shapes.ts";
import { dialogInput, dialogCancelBtn } from "./dialog-styles.ts";

// What each target deletes, in the words of someone who has to decide whether
// they want it gone. Used in the picker and again in the confirm sentence.
const TARGET_LABELS: Record<PruneTarget, string> = {
  transcripts: "Conversation transcripts",
  attachments: "Chat attachments",
};

// Why the planner spared something. The wire reasons are terse enum values; a
// person reading a preview wants the actual reason, not the enum.
const SKIP_LABELS: Record<PruneSkipReason, string> = {
  "too-recent": "newer than the age limit",
  "keep-newest": "among the newest kept for their agent",
  "active-session": "belongs to a conversation that is still live",
  "fork-ancestor": "another conversation was forked from it",
  referenced: "still shown in a conversation you can read",
  "queue-state-unknown": "waiting on a message queue that could not be read",
};

// Enough candidates to recognize what is about to go, not so many that the
// preview becomes the thing you scroll past to reach the button.
const SAMPLE_ROWS = 8;

const DEFAULT_OLDER_THAN_DAYS = 90;
const DEFAULT_KEEP_PER_AGENT = 5;

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "previewed"; plan: PrunePlanWire }
  | { kind: "confirming"; plan: PrunePlanWire }
  | { kind: "applying"; plan: PrunePlanWire }
  | { kind: "done"; result: PruneResultWire };

// `closeRef` is how the page asks before navigating away. A running prune is
// the one state worth blocking on: leaving does not stop it, and it throws
// away the only report of what was deleted. It replaces the old `onBack`,
// which returned to Office Settings, the only thing that rendered
// this panel and which stays mounted (with its unsaved edits) while we are up.
// There is no separate "close": one dialog layer at a time, so leaving here
// means going back there.
export function StoragePane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { isMobile } = useAppState();
  const [usage, setUsage] = useState<StorageUsageWire | null>(null);
  // null = still loading, "unavailable" = the probe failed. Both are distinct
  // from a backup that has never run, which is a real answer.
  const [backup, setBackup] = useState<BackupStatusWire | "unavailable" | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const [target, setTarget] = useState<PruneTarget>("transcripts");
  const [olderThanDays, setOlderThanDays] = useState(
    String(DEFAULT_OLDER_THAN_DAYS),
  );
  const [keepPerAgent, setKeepPerAgent] = useState(
    String(DEFAULT_KEEP_PER_AGENT),
  );
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirmText, setConfirmText] = useState("");
  const [pruneError, setPruneError] = useState<string | null>(null);
  // Monotonic ticket, bumped by every request AND by every form edit, so a
  // response that arrives after either one is discarded instead of installing
  // itself over newer state.
  const requestTicket = useRef(0);

  const loadUsage = useCallback(() => {
    apiFetch<StorageUsageWire>("GET", "/api/storage/usage")
      .then(setUsage)
      .catch((e: unknown) =>
        setLoadError(
          e instanceof ApiError ? e.message : "Could not measure storage.",
        ),
      );
  }, []);

  useEffect(() => {
    loadUsage();
    // A failed backup probe must not take the whole panel down - pruning does
    // not depend on it. But it must not silently DELETE the section either:
    // an absent Backups block is indistinguishable from "this office has no
    // backups", which is a very different and much more alarming fact.
    apiFetch<BackupStatusWire>("GET", "/api/backup/status")
      .then((b) => setBackup(b))
      .catch(() => setBackup("unavailable"));
  }, [loadUsage]);

  // Any change to what would be deleted invalidates the preview. Without this
  // you could preview a 90-day prune, retype it to 2 days, and press a delete
  // button still labelled with the 90-day count. Bumping the ticket also
  // orphans a preview still in flight, so its late response cannot undo this.
  function editForm(apply: () => void) {
    requestTicket.current++;
    apply();
    setPhase({ kind: "idle" });
    setConfirmText("");
    setPruneError(null);
  }

  const form: PolicyForm = { target, olderThanDays, keepPerAgent };
  const formValid = previewRequest(form) !== null;

  async function runPreview() {
    const body = previewRequest(form);
    if (!body) return;
    const ticket = ++requestTicket.current;
    setPruneError(null);
    setPhase({ kind: "previewing" });
    try {
      const res = await apiFetch<StoragePruneRes>(
        "POST",
        "/api/storage/prune",
        body,
      );
      // Two independent staleness checks, because they catch different things.
      // The ticket catches a superseded request; planMatchesForm catches a plan
      // that no longer describes the controls it would be displayed under. A
      // plan shown beneath a form it does not match is the whole failure mode
      // this flow exists to prevent.
      if (ticket !== requestTicket.current) return;
      if (!planMatchesForm(res.plan, form)) return;
      setPhase({ kind: "previewed", plan: res.plan });
    } catch (e) {
      if (ticket !== requestTicket.current) return;
      setPhase({ kind: "idle" });
      setPruneError(
        e instanceof ApiError ? e.message : "The prune request failed.",
      );
    }
  }

  // The delete is built from the PLAN, not from the form. The user confirmed a
  // specific set of files; the form is not consulted again and so cannot have
  // drifted underneath that confirmation.
  async function runApply(plan: PrunePlanWire) {
    const ticket = ++requestTicket.current;
    setPruneError(null);
    setPhase({ kind: "applying", plan });
    try {
      const res = await apiFetch<StoragePruneRes>(
        "POST",
        "/api/storage/prune",
        applyRequest(plan),
      );
      if (ticket !== requestTicket.current) return;
      // A response to an apply with no `applied` payload would mean the server
      // treated it as a dry run - surface that rather than report a deletion
      // that did not happen.
      if (!res.applied) {
        setPhase({ kind: "idle" });
        setPruneError("The delete did not run. Nothing was removed.");
        return;
      }
      setPhase({ kind: "done", result: res.applied });
      setConfirmText("");
      // The measurement is now stale by exactly what we deleted.
      loadUsage();
    } catch (e) {
      if (ticket !== requestTicket.current) return;
      setPhase({ kind: "idle" });
      setPruneError(
        e instanceof ApiError ? e.message : "The delete request failed.",
      );
    }
  }

  const plan =
    phase.kind === "previewed" ||
    phase.kind === "confirming" ||
    phase.kind === "applying"
      ? phase.plan
      : null;
  // Fail-closed: the planner spares everything when it cannot tell which
  // attachments are still owed to undelivered messages, and the server refuses
  // an apply in that state. Say so instead of offering a button that 409s.
  const queueUnreadable =
    plan?.skipped.some((s) => s.reason === "queue-state-unknown") ?? false;

  // While a request is in flight the policy controls are frozen: editing them
  // mid-preview is what produced a plan displayed under controls it no longer
  // described.
  const busy = phase.kind === "previewing" || phase.kind === "applying";
  // Once the DELETE has been sent there is nothing left to cancel - the server
  // is already unlinking. Letting someone navigate away silently would let them
  // reasonably believe they had stopped it, while also throwing away the only
  // receipt they will ever get.
  const deleting = phase.kind === "applying";
  // As a pane there is no Escape or backdrop to hold shut, so the guard moves
  // into the page's unsaved-changes ref. Mirrored every render (the no-deps
  // pattern the other panes use) so the closure sees the live phase.
  useEffect(() => {
    if (closeRef) {
      closeRef.current = (after?: () => void) => {
        if (
          deleting &&
          !confirm(
            "A cleanup is still running. If you leave now you lose the only report of what it deleted. Leave anyway?",
          )
        ) {
          return;
        }
        after?.();
      };
    }
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          marginTop: isMobile ? "env(safe-area-inset-top, 16px)" : undefined,
          marginBottom: isMobile ? 24 : undefined,
          width: isMobile ? "calc(100% - 32px)" : 560,
          maxWidth: isMobile ? "100%" : undefined,
          maxHeight: isMobile ? "calc(100dvh - 48px)" : "90vh",
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        {/* The scroll lives HERE, not on the backdrop. A backdrop that centers
            a taller-than-viewport child pushes its top edge off-screen, and no
            amount of scrolling brings it back: scroll offsets cannot go
            negative. Capping the panel and scrolling inside it is what the
            other tall dialogs do (EditAgentDialog, CronjobDialog). */}
        <div style={{ overflowY: "auto", flex: 1, padding: "24px 28px 0" }}>
          <h3
            style={{
              fontSize: 17,
              fontWeight: 700,
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            Office Storage
          </h3>

          <UsageBlock usage={usage} error={loadError} />
          <BackupBlock backup={backup} />

          <SectionLabel>Delete old files</SectionLabel>
          <div
            style={{
              border: "1px solid rgba(255,107,107,0.45)",
              background: "rgba(255,107,107,0.08)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-secondary)",
            }}
          >
            <strong style={{ color: "#ff6b6b" }}>
              This permanently deletes files from this machine.
            </strong>{" "}
            There is no undo and no trash. Old conversations and attachments are
            only ever deleted when you run this cleanup.
          </div>

          <FieldLabel>What to delete</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            {(Object.keys(TARGET_LABELS) as PruneTarget[]).map((t) => (
              <button
                key={t}
                onClick={() => editForm(() => setTarget(t))}
                disabled={busy}
                style={{
                  ...dialogCancelBtn,
                  flex: 1,
                  borderColor: target === t ? "var(--accent)" : "var(--border)",
                  color:
                    target === t ? "var(--text-primary)" : "var(--text-dim)",
                  background: target === t ? "var(--bg-input)" : "transparent",
                  opacity: busy ? 0.5 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {TARGET_LABELS[t]}
              </button>
            ))}
          </div>

          <FieldLabel>Older than</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="number"
              min={1}
              value={olderThanDays}
              disabled={busy}
              onChange={(e) => editForm(() => setOlderThanDays(e.target.value))}
              style={{ ...dialogInput, width: 90, opacity: busy ? 0.5 : 1 }}
            />
            <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>
              days. Anything touched more recently is kept.
            </span>
          </div>

          {target === "transcripts" && (
            <>
              <FieldLabel>Always keep, per agent</FieldLabel>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="number"
                  min={0}
                  value={keepPerAgent}
                  disabled={busy}
                  onChange={(e) =>
                    editForm(() => setKeepPerAgent(e.target.value))
                  }
                  style={{ ...dialogInput, width: 90, opacity: busy ? 0.5 : 1 }}
                />
                <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>
                  newest conversations, however old they are. 0 spares none on
                  that basis.
                </span>
              </div>
            </>
          )}

          {/* Stays available after a delete too: the receipt below is replaced by
              a fresh preview when one is run, so a second pass never reads as a
              continuation of the finished one. */}
          <button
            onClick={() => void runPreview()}
            disabled={!formValid || busy}
            style={{
              ...dialogCancelBtn,
              marginTop: 14,
              width: "100%",
              opacity: formValid && !busy ? 1 : 0.5,
              cursor: formValid && !busy ? "pointer" : "not-allowed",
            }}
          >
            {phase.kind === "previewing"
              ? "Checking…"
              : "Preview what would be deleted"}
          </button>

          {pruneError && <ErrorLine>{pruneError}</ErrorLine>}

          {plan && (
            <PlanBlock
              plan={plan}
              queueUnreadable={queueUnreadable}
              phase={phase}
              confirmText={confirmText}
              onConfirmText={setConfirmText}
              onAskConfirm={() => setPhase({ kind: "confirming", plan })}
              onCancelConfirm={() => {
                setPhase({ kind: "previewed", plan });
                setConfirmText("");
              }}
              onApply={() => void runApply(plan)}
            />
          )}

          {phase.kind === "done" && <ResultBlock result={phase.result} />}
        </div>

      </div>
    </div>
  );
}

function UsageBlock({
  usage,
  error,
}: {
  usage: StorageUsageWire | null;
  error: string | null;
}) {
  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!usage)
    return (
      <p style={{ fontSize: 11, color: "var(--text-ghost)", marginTop: 16 }}>
        Measuring…
      </p>
    );

  const byId = new Map(usage.categories.map((c) => [c.id, c] as const));
  const outsideBytes = OUT_OF_ROOT_ORDER.reduce(
    (sum, id) => sum + (byId.get(id)?.bytes ?? 0),
    0,
  );
  const total = usage.stateRootBytes + outsideBytes;

  return (
    <>
      <SectionLabel>What is on disk</SectionLabel>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
        <strong>{formatSize(total)} total</strong>
        {outsideBytes > 0
          ? ` - ${formatSize(usage.stateRootBytes)} of office state, plus ${formatSize(outsideBytes)} outside it.`
          : ", all of it office state."}{" "}
        <span style={{ color: "var(--text-ghost)" }}>
          Measured {formatRelativeTime(usage.measuredAt)}.
        </span>
      </p>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: 10,
          fontSize: 11,
        }}
      >
        <tbody>
          {IN_ROOT_ORDER.map((id) => (
            <CategoryRow key={id} cat={byId.get(id)} id={id} />
          ))}
          <tr>
            <td style={{ ...cell, fontWeight: 700 }}>Total office state</td>
            <td style={{ ...cellRight, fontWeight: 700 }}>
              {formatSize(usage.stateRootBytes)}
            </td>
            <td style={cellRight} />
          </tr>
          {/* The rows below are NOT part of the subtotal above them. Saying so
              in the table beats relying on the footnote to undo the impression
              that the whole column adds up to one number. */}
          <tr>
            <td
              colSpan={3}
              style={{
                ...cell,
                paddingTop: 10,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                color: "var(--text-ghost)",
                borderBottom: "none",
              }}
            >
              Outside office state
            </td>
          </tr>
          {OUT_OF_ROOT_ORDER.map((id) => (
            <CategoryRow key={id} cat={byId.get(id)} id={id} />
          ))}
        </tbody>
      </table>
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "6px 0 0" }}
      >
        Backups and update snapshots sit outside the office state directory, so
        they are listed after its subtotal. &ldquo;none&rdquo; means that
        location is not set up on this machine.
      </p>
    </>
  );
}

function CategoryRow({
  cat,
  id,
}: {
  cat: StorageCategoryWire | undefined;
  id: keyof typeof CATEGORY_LABELS;
}) {
  // A category the measurement didn't return at all can only mean the contract
  // changed underneath this file; skip it rather than paint a phantom zero.
  if (!cat) return null;
  return (
    <tr>
      <td style={cell}>{CATEGORY_LABELS[id]}</td>
      <td style={cellRight}>
        {cat.available ? formatSize(cat.bytes) : "none"}
      </td>
      <td style={{ ...cellRight, color: "var(--text-ghost)" }}>
        {cat.available ? cat.files.toLocaleString() : "-"}
      </td>
    </tr>
  );
}

function BackupBlock({
  backup,
}: {
  backup: BackupStatusWire | "unavailable" | null;
}) {
  if (backup === null) return null;
  if (backup === "unavailable") {
    return (
      <>
        <SectionLabel>Backups</SectionLabel>
        <p style={{ fontSize: 11, color: "var(--text-ghost)", margin: 0 }}>
          Backup status unavailable.
        </p>
      </>
    );
  }
  return (
    <>
      <SectionLabel>Backups</SectionLabel>
      <p
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {backup.lastRunAt === null ? (
          "No backup has run yet."
        ) : backup.ok ? (
          <>Last backup {formatRelativeTime(backup.lastRunAt)}, successful.</>
        ) : (
          <span style={{ color: "#ff6b6b" }}>
            Last backup {formatRelativeTime(backup.lastRunAt)} FAILED
            {backup.error ? `: ${backup.error}` : "."}
          </span>
        )}{" "}
        <span style={{ color: "var(--text-ghost)" }}>
          Keeping {backup.retention} in{" "}
          <code style={{ fontFamily: "'JetBrains Mono',monospace" }}>
            {backup.destDir}
          </code>
          .
        </span>
      </p>
    </>
  );
}

function PlanBlock({
  plan,
  queueUnreadable,
  phase,
  confirmText,
  onConfirmText,
  onAskConfirm,
  onCancelConfirm,
  onApply,
}: {
  plan: PrunePlanWire;
  queueUnreadable: boolean;
  phase: Phase;
  confirmText: string;
  onConfirmText: (v: string) => void;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onApply: () => void;
}) {
  const count = plan.candidates.length;
  const sample = plan.candidates.slice(0, SAMPLE_ROWS);
  const targetWord = TARGET_LABELS[plan.target].toLowerCase();

  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 14px",
        background: "var(--bg-input)",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          color: count > 0 ? "var(--text-primary)" : "var(--text-dim)",
        }}
      >
        {count > 0
          ? `${count.toLocaleString()} ${targetWord} would be deleted, freeing ${formatSize(plan.bytes)}.`
          : `Nothing matches. No ${targetWord} are old enough to delete.`}
      </p>
      <p
        style={{ margin: "4px 0 0", fontSize: 10, color: "var(--text-ghost)" }}
      >
        Nothing has been deleted yet - this is a preview.
      </p>

      {plan.skipped.length > 0 && (
        <ul
          style={{
            margin: "8px 0 0",
            paddingLeft: 16,
            fontSize: 11,
            color: "var(--text-dim)",
            lineHeight: 1.6,
          }}
        >
          {plan.skipped.map((s) => (
            <li key={s.reason}>
              {s.count.toLocaleString()} kept ({formatSize(s.bytes)}):{" "}
              {SKIP_LABELS[s.reason]}
            </li>
          ))}
        </ul>
      )}

      {sample.length > 0 && (
        <div
          style={{
            marginTop: 8,
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10,
            color: "var(--text-ghost)",
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          {sample.map((c) => (
            <div key={c.path}>
              {c.path} - {formatSize(c.bytes)}, {c.ageDays}d old
            </div>
          ))}
          {count > sample.length && (
            <div>…and {(count - sample.length).toLocaleString()} more.</div>
          )}
        </div>
      )}

      {queueUnreadable && (
        <ErrorLine>
          Isomux could not read the pending-message queue, so it cannot tell
          which attachments are still owed to messages that have not been
          delivered. Nothing will be deleted until that is readable again.
        </ErrorLine>
      )}

      {count > 0 && !queueUnreadable && phase.kind === "previewed" && (
        <button onClick={onAskConfirm} style={dangerBtn}>
          Delete {count.toLocaleString()} {targetWord} permanently
        </button>
      )}

      {(phase.kind === "confirming" || phase.kind === "applying") && (
        <div style={{ marginTop: 12 }}>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-secondary)",
            }}
          >
            <strong style={{ color: "#ff6b6b" }}>This cannot be undone.</strong>{" "}
            The preview found {formatSize(plan.bytes)} of {targetWord} to erase
            from this machine. A backup may contain another copy, if one ran
            after these files were written. Isomux scans again before deleting.
            Files that no longer match or fail a safety check are kept, so the
            final count may differ from this preview.
          </p>
          <input
            value={confirmText}
            onChange={(e) => onConfirmText(e.target.value)}
            placeholder="Type DELETE to confirm"
            autoFocus
            style={{ ...dialogInput, marginTop: 8 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={onCancelConfirm}
              style={{ ...dialogCancelBtn, flex: 1 }}
              disabled={phase.kind === "applying"}
            >
              Cancel
            </button>
            <button
              onClick={onApply}
              disabled={confirmText !== "DELETE" || phase.kind === "applying"}
              style={{
                ...dangerBtn,
                marginTop: 0,
                flex: 1,
                opacity: confirmText === "DELETE" ? 1 : 0.5,
                cursor: confirmText === "DELETE" ? "pointer" : "not-allowed",
              }}
            >
              {phase.kind === "applying" ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultBlock({ result }: { result: PruneResultWire }) {
  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 14px",
        background: "var(--bg-input)",
      }}
    >
      {result.aborted ? (
        <p style={{ margin: 0, fontSize: 12, color: "#ff6b6b" }}>
          Stopped before deleting anything: {result.aborted}
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-primary)" }}>
          Deleted {result.deleted.toLocaleString()} files, freeing{" "}
          {formatSize(result.bytes)}.
        </p>
      )}
      {result.refused.length > 0 && (
        <p
          style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)" }}
        >
          {result.refused.length.toLocaleString()} could not be removed and were
          left alone.
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: "var(--text-muted)",
        margin: "20px 0 8px",
      }}
    >
      {children}
    </h4>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-muted)",
        margin: "14px 0 5px",
      }}
    >
      {children}
    </label>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 11,
        color: "#ff6b6b",
        margin: "8px 0 0",
        lineHeight: 1.5,
      }}
    >
      {children}
    </p>
  );
}

const cell: React.CSSProperties = {
  padding: "3px 0",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
};
const cellRight: React.CSSProperties = {
  ...cell,
  textAlign: "right",
  fontFamily: "'JetBrains Mono',monospace",
};
const dangerBtn: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid #ff6b6b",
  background: "rgba(255,107,107,0.15)",
  color: "#ff6b6b",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
