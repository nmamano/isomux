import {
  useEffect,
  useCallback,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { formatDateTime } from "../../shared/i18n/time.ts";
import {
  DEFAULT_LANGUAGE,
  type SupportedLanguageCode,
} from "../../shared/languages.ts";
import { CopyButton } from "./CopyButton.tsx";
import { apiFetch } from "../api.ts";
import { reloadBrowser } from "../reload-browser.ts";
import type { UpdateStatusWire } from "../../shared/types.ts";
import {
  buildCommitNotice,
  type CommitNotice,
} from "../../shared/update-notice.ts";

const REPO = "nmamano/isomux";

// Not a component, so the language arrives as an argument (ruling 18). The
// clipboard builders above pass DEFAULT_LANGUAGE on purpose: their whole text
// is agent-facing and stays English.
function formatDate(language: SupportedLanguageCode, iso: string): string {
  if (!iso) return "";
  return formatDateTime(language, new Date(iso).getTime(), "fullDate");
}

type CommitStatus = Extract<UpdateStatusWire, { mode: "commit" }>;
type ReleaseStatus = Extract<UpdateStatusWire, { mode: "release" }>;

// The two plain-text builders below compose what the copy button puts on the
// clipboard, which the pane's own tip says to hand to an agent. Agents keep
// seeing English (internal-docs/i18n-loop.md, north star), so this text is
// not a UI string and stays out of the catalog on purpose; the visible pane
// around it is translated.
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
    "4. Refresh the browser after the server restarts.",
  ].join("\n");
}

function buildReleasePlainText(s: ReleaseStatus): string {
  const running =
    s.current.release ?? s.current.version ?? "an unknown version";
  const lines = ["New Release Available", "", `- You are on ${running}`];
  if (s.latest) {
    lines.push(
      `- Latest release: ${s.latest.tag}${s.latest.publishedAt ? ` (${formatDate(DEFAULT_LANGUAGE, s.latest.publishedAt)})` : ""}${s.latest.url ? `: ${s.latest.url}` : ""}`,
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

// The <code> wrap of the catalog's rich entries (ruling 16).
const inCode = (chunk: ReactNode) => <code style={code}>{chunk}</code>;

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
  const { t, rich } = useI18n();
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
            {t("settings.update.releaseNotesParen")}
          </a>
        ) : (
          <a
            href={`https://github.com/${REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--blue, #58a6ff)", textDecoration: "none" }}
          >
            {t("settings.update.githubParen")}
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
        {t("settings.update.toUpdate")}
      </p>
      <ol style={{ ...textStyle, margin: 0, paddingLeft: 20 }}>
        <li>{t("settings.update.stepPull")}</li>
        <li style={{ marginTop: 4 }}>
          {rich("settings.update.stepInstall", { code: inCode })}
        </li>
        <li style={{ marginTop: 4 }}>
          {rich("settings.update.stepRestart", { code: inCode })}
        </li>
        <li style={{ marginTop: 4 }}>{t("settings.update.stepRefresh")}</li>
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
        {t("settings.update.tip")}
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
  onStart,
  onStartError,
}: {
  status: ReleaseStatus;
  onClose: () => void;
  onStart: () => void;
  onStartError: () => void;
}) {
  const { sessionContext } = useAppState();
  const { t, tn, rich, language } = useI18n();
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
    onStart();
    setPhase("starting");
    setError(null);
    try {
      await apiFetch("POST", "/api/office/update", { tag: latest.tag });
      setPhase("started");
    } catch (err) {
      onStartError();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  }, [latest, onStart, onStartError]);

  return (
    <>
      <ul style={{ ...textStyle, margin: "16px 0 0", paddingLeft: 20 }}>
        <li>
          {rich("settings.update.runningOn", {
            version: running ?? t("settings.update.unknownVersion"),
            code: inCode,
          })}
        </li>
        {latest && (
          <li style={{ marginTop: 4 }}>
            {rich("settings.update.latestRelease", {
              tag: latest.tag,
              published: latest.publishedAt
                ? ` (${formatDate(language, latest.publishedAt)})`
                : "",
              code: inCode,
            })}
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
                  {t("settings.update.releaseNotes")}
                </a>
              </>
            )}
          </li>
        )}
      </ul>

      {(phase === "starting" || phase === "started") && (
        <div role="status" style={{ ...textStyle, marginTop: 16 }}>
          <p>{t("settings.update.waiting")}</p>
          <p>{t("settings.update.requested")}</p>
        </div>
      )}

      {(phase === "confirm" || phase === "starting") && (
        <p style={{ ...textStyle, margin: "16px 0 0" }}>
          {t("settings.update.restartWarning")}
          {busy !== null &&
            " " +
              (busy === 0
                ? t("settings.update.busyNone")
                : tn("settings.update.busy", busy))}
          {busy === null &&
            busyUnavailable &&
            " " + t("settings.update.busyUnavailable")}
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
          {t("settings.update.ownerOnly")}
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
            {t("settings.update.updateNow")}
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
              ? t("settings.update.updating")
              : busy !== null
                ? t("settings.update.updateNowBusy", { count: busy })
                : t("settings.update.updateNow")}
          </button>
        )}
        <button
          onClick={phase === "confirm" ? () => setPhase("info") : onClose}
          style={phase === "info" && !isOwner ? buttonStyle : quietButtonStyle}
        >
          {phase === "confirm" || phase === "starting"
            ? t("common.cancel")
            : phase === "started"
              ? t("common.close")
              : t("settings.update.gotIt")}
        </button>
      </div>
    </>
  );
}

// The Updates pane. `onClose` leaves the settings page entirely: it is what
// the old dialog's Close and "Got it" buttons did, and there is nothing
// smaller to dismiss now that this is a pane rather than an overlay.
export function UpdatePane({ onClose }: { onClose: () => void }) {
  const { updateInfo, hydrationEpoch } = useAppState();
  // Keep completion independent of ReleaseBody so a server mode change cannot
  // discard it. Retain the requested release context while the check is pending.
  const [attempt, setAttempt] = useState<{
    baseline: string | null;
    epoch: number;
    status: ReleaseStatus;
  } | null>(null);
  const [result, setResult] = useState<
    "done" | "unchanged" | "unverified" | null
  >(null);

  const latestEpoch = useRef(hydrationEpoch);
  useEffect(() => {
    latestEpoch.current = hydrationEpoch;
  }, [hydrationEpoch]);

  const onStart = useCallback(() => {
    if (updateInfo?.mode !== "release") return;
    setResult(null);
    setAttempt({
      baseline: updateInfo.current.release ?? updateInfo.current.version,
      epoch: hydrationEpoch,
      status: updateInfo,
    });
  }, [updateInfo, hydrationEpoch]);
  const onStartError = useCallback(() => {
    // A failed launch before any reconnect returns to the confirmation step.
    setAttempt((current) =>
      current?.epoch === latestEpoch.current ? null : current,
    );
  }, []);

  useEffect(() => {
    if (!attempt || hydrationEpoch <= attempt.epoch) return;
    let cancelled = false;
    apiFetch<{ status: UpdateStatusWire }>("GET", "/api/office/update")
      .then(({ status }) => {
        if (cancelled) return;
        const current =
          status.mode === "release"
            ? (status.current.release ?? status.current.version)
            : (status.current.release ?? status.current.sha);
        setResult(
          !attempt.baseline || !current
            ? "unverified"
            : current !== attempt.baseline
              ? "done"
              : "unchanged",
        );
      })
      .catch(() => {
        if (!cancelled) setResult("unverified");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, hydrationEpoch]);
  const i18n = useI18n();
  const { t } = i18n;

  const release =
    attempt?.status ?? (updateInfo?.mode === "release" ? updateInfo : null);
  const commit = updateInfo?.mode === "commit" ? updateInfo : null;
  // Null while quiet - the pill is hidden then, so this pane normally opens
  // with something to say; the guard below covers the status going quiet
  // while the pane is up.
  const notice = commit ? buildCommitNotice(i18n, commit) : null;

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
            {result
              ? t("settings.sidebar.updates")
              : release
                ? t("settings.update.newRelease")
                : (notice?.title ?? t("settings.update.upToDateTitle"))}
          </h3>
          {!result && <CopyButton getText={getText} size={28} />}
        </div>

        {result ? (
          <div role="status" style={{ ...textStyle, marginTop: 16 }}>
            <p>
              {t(
                result === "done"
                  ? "settings.update.done"
                  : result === "unchanged"
                    ? "settings.update.unchanged"
                    : "settings.update.unverified",
              )}
            </p>
            {result === "unchanged" && <p>{t("settings.update.requested")}</p>}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 20,
              }}
            >
              <button onClick={() => reloadBrowser()} style={buttonStyle}>
                {t("settings.update.refreshBrowser")}
              </button>
            </div>
          </div>
        ) : release ? (
          <ReleaseBody
            status={release}
            onClose={onClose}
            onStart={onStart}
            onStartError={onStartError}
          />
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
                {t("settings.update.gotIt")}
              </button>
            </div>
          </>
        ) : (
          // Nothing to report: no release behind, no new commits. Reachable
          // now that the sidebar has a permanent Updates row, where the old
          // dialog could only be opened from the pill.
          <p style={{ ...textStyle, margin: "16px 0 0" }}>
            {t("settings.update.upToDate")}
          </p>
        )}
      </div>
    </div>
  );
}
