import { useEffect, useCallback, useState } from "react";
import { useAppState } from "../store.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { apiFetch } from "../api.ts";
import type { UpdateStatusWire } from "../../shared/types.ts";
import {
  buildCommitNotice,
  type CommitNotice,
} from "../../shared/update-notice.ts";

const REPO = "nmamano/isomux";

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type CommitStatus = Extract<UpdateStatusWire, { mode: "commit" }>;
type ReleaseStatus = Extract<UpdateStatusWire, { mode: "release" }>;

function buildCommitPlainText(notice: CommitNotice): string {
  return [
    notice.title,
    "",
    notice.notice,
    "",
    "To update:",
    "",
    "1. Pull the latest changes",
    "2. Run `bun install`",
    `3. Restart isomux for the update to take effect. Dev: \`bun run dev\`. User service: \`systemctl --user restart isomux\`. System service: \`sudo systemctl restart isomux\`.`,
  ].join("\n");
}

function buildReleasePlainText(s: ReleaseStatus): string {
  const running =
    s.current.release ?? s.current.version ?? "an unknown version";
  const lines = ["New Release Available", "", `- You are on ${running}`];
  if (s.latest) {
    lines.push(
      `- Latest release: ${s.latest.tag}${s.latest.publishedAt ? ` (${formatDate(s.latest.publishedAt)})` : ""}${s.latest.url ? `: ${s.latest.url}` : ""}`,
    );
    lines.push(
      "",
      `To update: use the update button in the office (owner-only), or as root on the server: isomux-update ${s.latest.tag}`,
    );
  }
  return lines.join("\n");
}

const code: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: "var(--text-primary)",
};

const textStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text-dim)",
  lineHeight: 1.6,
};

const buttonStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const quietButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--bg-code)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-light)",
};

// Commit-mode body: the source-checkout notice (running version, latest
// release, main drift - copy composed in shared/update-notice.ts) with manual
// update instructions.
function CommitBody({
  status,
  notice,
}: {
  status: CommitStatus;
  notice: CommitNotice;
}) {
  return (
    <>
      <p style={{ ...textStyle, margin: "16px 0 0" }}>
        {notice.notice}{" "}
        {status.latest?.url ? (
          <a
            href={status.latest.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--blue, #58a6ff)", textDecoration: "none" }}
          >
            (release notes)
          </a>
        ) : (
          <a
            href={`https://github.com/${REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--blue, #58a6ff)", textDecoration: "none" }}
          >
            (GitHub)
          </a>
        )}
      </p>

      <p
        style={{
          ...textStyle,
          margin: "16px 0 6px",
          fontWeight: 600,
          color: "var(--text-primary)",
        }}
      >
        To update:
      </p>
      <ol style={{ ...textStyle, margin: 0, paddingLeft: 20 }}>
        <li>Pull the latest changes</li>
        <li style={{ marginTop: 4 }}>
          Run <code style={code}>bun install</code>
        </li>
        <li style={{ marginTop: 4 }}>
          Restart isomux for the update to take effect. Dev:{" "}
          <code style={code}>bun run dev</code>. User service:{" "}
          <code style={code}>systemctl --user restart isomux</code>. System
          service: <code style={code}>sudo systemctl restart isomux</code>.
        </li>
      </ol>

      <p
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          marginTop: 14,
          lineHeight: 1.5,
          fontStyle: "italic",
        }}
      >
        Tip: click the copy button to copy this notice to clipboard, then ask
        any agent to take care of it.
      </p>
    </>
  );
}

// Release-mode body: what's running vs. the latest release, and (for owners)
// the update trigger with its confirm step. `phase` walks
// info -> confirm -> starting -> started, with `error` rendered inline.
function ReleaseBody({
  status,
  onClose,
}: {
  status: ReleaseStatus;
  onClose: () => void;
}) {
  const { sessionContext } = useAppState();
  const isOwner = sessionContext?.role === "owner";
  const [phase, setPhase] = useState<
    "info" | "confirm" | "starting" | "started"
  >("info");
  const [error, setError] = useState<string | null>(null);
  // Office-wide mid-turn count, computed by the server: the local agent store
  // is projected to this viewer's visible rooms and would undercount for a
  // room-restricted owner, while the restart interrupts everyone. Null while
  // loading or after a failed fetch - the copy then says the count is
  // unavailable rather than silently substituting the projected local count.
  const [busy, setBusy] = useState<number | null>(null);
  const [busyUnavailable, setBusyUnavailable] = useState(false);

  const loadBusy = useCallback(() => {
    if (!isOwner) return;
    apiFetch<{ busyAgents: number }>("GET", "/api/office/update")
      .then((r) => {
        setBusy(r.busyAgents);
        setBusyUnavailable(false);
      })
      .catch(() => {
        setBusy(null);
        setBusyUnavailable(true);
      });
  }, [isOwner]);
  useEffect(() => loadBusy(), [loadBusy]);

  const running = status.current.release ?? status.current.version;
  const latest = status.latest;

  const trigger = useCallback(async () => {
    if (!latest) return;
    setPhase("starting");
    setError(null);
    try {
      await apiFetch("POST", "/api/office/update", { tag: latest.tag });
      setPhase("started");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  }, [latest]);

  if (phase === "started") {
    return (
      <>
        <p style={{ ...textStyle, margin: "16px 0 0" }}>
          Update requested. The server will restart shortly and this page will
          reconnect. If nothing happens after a few minutes, check the
          updater&apos;s status file on the server.
        </p>
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}
        >
          <button onClick={onClose} style={buttonStyle}>
            Close
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <ul style={{ ...textStyle, margin: "16px 0 0", paddingLeft: 20 }}>
        <li>
          You are on <code style={code}>{running ?? "an unknown version"}</code>
        </li>
        {latest && (
          <li style={{ marginTop: 4 }}>
            Latest release: <code style={code}>{latest.tag}</code>
            {latest.publishedAt ? ` (${formatDate(latest.publishedAt)})` : ""}
            {latest.url && (
              <>
                {" - "}
                <a
                  href={latest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "var(--blue, #58a6ff)",
                    textDecoration: "none",
                  }}
                >
                  release notes
                </a>
              </>
            )}
          </li>
        )}
      </ul>

      {(phase === "confirm" || phase === "starting") && (
        <p style={{ ...textStyle, margin: "16px 0 0" }}>
          Updating restarts the server, interrupting every agent.
          {busy !== null &&
            " " +
              (busy === 0
                ? "No agents are mid-task right now."
                : busy === 1
                  ? "1 agent is mid-task right now."
                  : `${busy} agents are mid-task right now.`)}
          {busy === null &&
            busyUnavailable &&
            " The busy-agent count is unavailable right now."}
        </p>
      )}

      {error && (
        <p
          style={{
            ...textStyle,
            margin: "12px 0 0",
            color: "var(--red, #f85149)",
          }}
        >
          {error}
        </p>
      )}

      {!isOwner && (
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 14,
            lineHeight: 1.5,
            fontStyle: "italic",
          }}
        >
          An office owner can apply it from this dialog.
        </p>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        {isOwner && latest && phase === "info" && (
          <button
            onClick={() => {
              setPhase("confirm");
              loadBusy();
            }}
            style={buttonStyle}
          >
            Update now
          </button>
        )}
        {isOwner && latest && (phase === "confirm" || phase === "starting") && (
          <button
            onClick={() => void trigger()}
            disabled={phase === "starting"}
            style={{
              ...buttonStyle,
              opacity: phase === "starting" ? 0.6 : 1,
              cursor: phase === "starting" ? "default" : "pointer",
            }}
          >
            {phase === "starting"
              ? "Updating…"
              : busy !== null
                ? `Update now (${busy} busy)`
                : "Update now"}
          </button>
        )}
        <button
          onClick={phase === "confirm" ? () => setPhase("info") : onClose}
          style={phase === "info" && !isOwner ? buttonStyle : quietButtonStyle}
        >
          {phase === "confirm" || phase === "starting" ? "Cancel" : "Got it"}
        </button>
      </div>
    </>
  );
}

// The Updates pane. `onClose` leaves the settings page entirely: it is what
// the old dialog's Close and "Got it" buttons did, and there is nothing
// smaller to dismiss now that this is a pane rather than an overlay.
export function UpdatePane({ onClose }: { onClose: () => void }) {
  const { updateInfo } = useAppState();

  const release = updateInfo?.mode === "release" ? updateInfo : null;
  const commit = updateInfo?.mode === "commit" ? updateInfo : null;
  // Null while quiet - the pill is hidden then, so this pane normally opens
  // with something to say; the guard below covers the status going quiet
  // while the pane is up.
  const notice = commit ? buildCommitNotice(commit) : null;

  const getText = useCallback(
    () =>
      release
        ? buildReleasePlainText(release)
        : notice
          ? buildCommitPlainText(notice)
          : "",
    [release, notice],
  );

  return (
    <div style={{ marginTop: 24 }}>
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h3
            style={{
              fontSize: 17,
              fontWeight: 700,
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            {release
              ? "New Release Available"
              : (notice?.title ?? "Up to date")}
          </h3>
          <CopyButton getText={getText} size={28} />
        </div>

        {release ? (
          <ReleaseBody status={release} onClose={onClose} />
        ) : commit && notice ? (
          <>
            <CommitBody status={commit} notice={notice} />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 20,
              }}
            >
              <button onClick={onClose} style={buttonStyle}>
                Got it
              </button>
            </div>
          </>
        ) : (
          // Nothing to report: no release behind, no new commits. Reachable
          // now that the sidebar has a permanent Updates row, where the old
          // dialog could only be opened from the pill.
          <p style={{ ...textStyle, margin: "16px 0 0" }}>
            This office is up to date.
          </p>
        )}
      </div>
    </div>
  );
}
