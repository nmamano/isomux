// Settings > Office > Move office (task 78733adf, slice 2c-2): the owner
// moves this office to another machine (the move-out card) or moves an
// office here (the move-in card). ui/office-move.ts holds the logic;
// internal-docs/office-move-design.md describes the flow.
//
// The move routes emit nothing, so each card polls its GET while something
// runs. A poll that a locked server answers (the old office after its lock,
// a failed swap here) reloads the page, so the owner sees that server's page.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useConfirmStep } from "../hooks/useConfirmStep.ts";
import { reloadBrowser } from "../reload-browser.ts";
import { absoluteTime } from "../../shared/i18n/time.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { errMessage } from "../../shared/errors.ts";
import type {
  MintMoveCodeRes,
  MoveBoxInfo,
  MoveInCancelRes,
  MoveInFolderBlock,
  MoveInStartBlocker,
  MoveInStatus,
  MoveOutsideLeftReason,
  OfficeMoveRes,
} from "../../shared/office-move.ts";
import {
  MOVE_IN_POLL_MS,
  MOVE_LIST_MAX,
  copiedBytes,
  finishAllowed,
  leftBehindLines,
  listHead,
  moveInPollDecision,
  moveOutPollDecision,
  phaseView,
  type LeftBehindLine,
  type LiveView,
  type MoveInView,
  type OutsideFolderLine,
  type PollDecision,
  type PollOutcome,
  type PreflightView,
} from "../office-move.ts";
import {
  MintedSecretBox,
  cardStyle,
  hint,
  smallBtn,
} from "./access-shared.tsx";
import { sizeText } from "./StoragePane.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { armedConfirmLook, dialogSaveBtn } from "./dialog-styles.ts";

// ---- polling ----

/** Polls `path` and hands each outcome and decision to `onOutcome`. `decide`
 *  and `onOutcome` are read at each poll, so they may change per render. */
function useStatusPoll<S>(
  path: string,
  decide: (o: PollOutcome<S>) => PollDecision,
  onOutcome: (o: PollOutcome<S>, d: PollDecision) => void,
): () => void {
  const decideRef = useRef(decide);
  const onOutcomeRef = useRef(onOutcome);
  useLayoutEffect(() => {
    decideRef.current = decide;
    onOutcomeRef.current = onOutcome;
  });
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A newer poll (a refresh after a write) wins over one in flight.
    let generation = 0;
    const run = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const gen = ++generation;
      let outcome: PollOutcome<S>;
      try {
        outcome = { kind: "status", status: await apiFetch<S>("GET", path) };
      } catch (error) {
        outcome =
          error instanceof ApiError && error.locked
            ? { kind: "locked" }
            : { kind: "error", error };
      }
      if (!alive || gen !== generation) return;
      const d = decideRef.current(outcome);
      onOutcomeRef.current(outcome, d);
      if (d.kind === "reload") reloadBrowser();
      else if (d.kind !== "stop")
        timer = setTimeout(
          () => void run(),
          d.kind === "wait" ? d.ms : MOVE_IN_POLL_MS,
        );
    };
    refreshRef.current = () => void run();
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path]);

  return useCallback(() => refreshRef.current(), []);
}

// ---- shared bits ----

interface CardError {
  message: string;
  detail?: Record<string, unknown>;
}

const toCardError = (e: unknown): CardError =>
  e instanceof ApiError
    ? { message: e.message, ...(e.detail ? { detail: e.detail } : {}) }
    : { message: errMessage(e) };

const text: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-primary)",
  lineHeight: 1.45,
  margin: "6px 0 0",
};
const warning: React.CSSProperties = { ...text, color: "var(--red-text)" };
const heading: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  margin: 0,
  color: "var(--text-primary)",
};
const list: React.CSSProperties = {
  ...text,
  paddingLeft: 18,
  wordBreak: "break-all",
};
const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
};
const row: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 10,
  alignItems: "center",
};
const primaryBtn: React.CSSProperties = { ...dialogSaveBtn };
const secondaryBtn: React.CSSProperties = {
  ...smallBtn,
  padding: "6px 12px",
  fontSize: 12,
};

function ErrorLine({ error }: { error: CardError | null }) {
  if (!error) return null;
  return (
    <p data-testid="move-error" role="alert" style={warning}>
      {error.message}
    </p>
  );
}

// ---- the pane ----

export function OfficeMovePane(): React.ReactElement {
  const { t } = useI18n();
  // The move-in card's phase decides the order: it comes first on a new
  // office and while a move-in runs or is done (the report on top).
  const [inFirst, setInFirst] = useState(false);
  return (
    <div style={{ marginTop: 24 }}>
      <h3
        style={{
          fontSize: 17,
          fontWeight: 700,
          margin: 0,
          color: "var(--text-primary)",
        }}
      >
        {t("officeMove.title")}
      </h3>
      <p style={{ ...hint, margin: "6px 0 0" }}>{t("officeMove.intro")}</p>
      {/* Keyed, so a reorder moves the cards and keeps their state. */}
      {(inFirst ? ["in", "out"] : ["out", "in"]).map((card) =>
        card === "in" ? (
          <MoveInCard key="in" onFirst={setInFirst} />
        ) : (
          <MoveOutCard key="out" />
        ),
      )}
    </div>
  );
}

// ---- move out (the old office) ----

interface OutState {
  status: OfficeMoveRes | null;
  /** The code of the mint just made: shown once, kept in memory only. */
  minted: MintMoveCodeRes | null;
  action: "mint" | "cancel" | null;
  error: CardError | null;
  /** The last poll's error; the next status clears it. */
  pollError: CardError | null;
}

function MoveOutCard() {
  const { t, language } = useI18n();
  const [state, setState] = useState<OutState>({
    status: null,
    minted: null,
    action: null,
    error: null,
    pollError: null,
  });
  const confirm = useConfirmStep();
  const refresh = useStatusPoll<OfficeMoveRes>(
    "/api/office/move",
    moveOutPollDecision,
    (o) => {
      if (o.kind === "status")
        setState((s) => ({ ...s, status: o.status, pollError: null }));
      // After the lock, errors are the old office's restart.
      else if (o.kind === "error")
        setState((s) =>
          s.status?.state === "move"
            ? s
            : { ...s, pollError: toCardError(o.error) },
        );
    },
  );

  async function mint() {
    setState((s) => ({ ...s, action: "mint", error: null }));
    try {
      const minted = await apiFetch<MintMoveCodeRes>(
        "POST",
        "/api/office/move/code",
      );
      setState((s) => ({ ...s, minted, action: null }));
    } catch (e) {
      setState((s) => ({ ...s, action: null, error: toCardError(e) }));
    }
    refresh();
  }

  async function cancel() {
    setState((s) => ({ ...s, action: "cancel", error: null }));
    try {
      await apiFetch("DELETE", "/api/office/move");
      setState((s) => ({ ...s, minted: null, action: null }));
    } catch (e) {
      setState((s) => ({ ...s, action: null, error: toCardError(e) }));
    }
    refresh();
  }

  const { status, minted, action, error, pollError } = state;
  const moveState = status?.state ?? null;
  const time = (ts: number) => absoluteTime(language, ts);
  return (
    <section data-testid="move-out" style={{ ...cardStyle, marginTop: 16 }}>
      <h4 style={heading}>{t("officeMove.out.heading")}</h4>
      <p style={text}>{t("officeMove.out.steps")}</p>
      <p style={text}>{t("officeMove.out.needs")}</p>
      <p style={text}>{t("officeMove.out.signIns")}</p>
      {minted?.loopbackOrigin && (
        <p data-testid="move-loopback-warning" style={warning}>
          {t("officeMove.out.loopback", { origin: minted.origin })}
        </p>
      )}
      {minted && (
        <div data-testid="move-code">
          <MintedSecretBox
            value={minted.code}
            label={t("officeMove.out.codeLabel")}
            hint={t("officeMove.out.codeHint", {
              time: time(minted.expiresAt),
            })}
            blocked={t("officeMove.out.clipboardBlocked")}
            copyTitle={t("officeMove.out.copyTitle")}
          />
        </div>
      )}
      {moveState === "code" && typeof status?.expiresAt === "number" && (
        <p style={text}>
          {t("officeMove.out.waiting", { time: time(status.expiresAt) })}
        </p>
      )}
      {moveState === "paired" && (
        <p style={text}>{t("officeMove.out.paired")}</p>
      )}
      {/* Slice 4: the new machine copies while this office runs. */}
      {moveState === "paired" && typeof status?.servedAt === "number" && (
        <p data-testid="move-out-served" style={text}>
          {t("officeMove.out.served", { time: time(status.servedAt) })}
        </p>
      )}
      {moveState === "move" && <p style={text}>{t("officeMove.out.locked")}</p>}
      <ErrorLine error={error ?? pollError} />
      <div style={row}>
        {/* Before the first status, the start button shows disabled. */}
        {(moveState === null ||
          moveState === "none" ||
          moveState === "code") && (
          <button
            data-testid="move-mint"
            disabled={moveState === null || action !== null}
            onClick={() => void mint()}
            style={moveState === "code" ? secondaryBtn : primaryBtn}
          >
            {t(
              moveState === "code"
                ? "officeMove.out.mintAgain"
                : "officeMove.out.mint",
            )}
          </button>
        )}
        {(moveState === "code" || moveState === "paired") && (
          <button
            data-testid="move-out-cancel"
            {...confirm.bind("cancel")}
            disabled={action !== null}
            onClick={() => confirm.confirm("cancel", () => void cancel())}
            style={{
              ...secondaryBtn,
              ...(confirm.armed === "cancel" ? armedConfirmLook : {}),
            }}
          >
            {t(
              confirm.armed === "cancel"
                ? "common.confirmQuestion"
                : "officeMove.out.cancel",
            )}
          </button>
        )}
      </div>
    </section>
  );
}

const versionOf = (box: { release: string | null; commit: string | null }) =>
  box.release ?? (box.commit ? box.commit.slice(0, 12) : "?");

// ---- move in (the new office) ----

interface InState {
  status: MoveInStatus | null;
  action:
    | "start"
    | "lock"
    | "preflight"
    | "live"
    | "finish"
    | "pull"
    | "cancel"
    | null;
  error: CardError | null;
  /** The check the confirm card showed when `error` came: a status with
   *  another check drops the error, which the new check makes moot. */
  errorCheck: string | null;
  /** The code field. */
  code: string;
  /** "Finish without these files" on an incomplete copy. */
  acceptMissing: boolean;
  /** The last cancel's answer: says whether the old office stays locked. */
  cancelled: MoveInCancelRes | null;
  /** finishing/swapping with no answer for the cap. */
  lost: boolean;
  /** The last poll's error outside the restart; the next status clears it. */
  pollError: CardError | null;
}

const RESTART_PHASES = new Set<MoveInStatus["phase"]>([
  "finishing",
  "swapping",
]);

function MoveInCard({ onFirst }: { onFirst: (first: boolean) => void }) {
  const { t, tn, language } = useI18n();
  const [state, setState] = useState<InState>({
    status: null,
    action: null,
    error: null,
    errorCheck: null,
    code: "",
    acceptMissing: false,
    cancelled: null,
    lost: false,
    pollError: null,
  });
  const confirm = useConfirmStep();
  // When the pane first saw the restart; the cap counts from it.
  const restartingSince = useRef<number | null>(null);

  const take = (status: MoveInStatus) => {
    if (!RESTART_PHASES.has(status.phase)) restartingSince.current = null;
    else restartingSince.current ??= Date.now();
    setState((s) => {
      const newCheck =
        s.errorCheck !== null &&
        status.phase === "confirm" &&
        status.preflightId !== s.errorCheck;
      return {
        ...s,
        status,
        lost: false,
        pollError: null,
        ...(newCheck ? { error: null, errorCheck: null } : {}),
      };
    });
  };

  const refresh = useStatusPoll<MoveInStatus>(
    "/api/office/move-in",
    (o) =>
      moveInPollDecision(o, {
        restartingSince: restartingSince.current,
        now: Date.now(),
      }),
    (o, d) => {
      if (o.kind === "status") take(o.status);
      else if (d.kind === "lost") setState((s) => ({ ...s, lost: true }));
      // Errors during finishing and swapping are the restart.
      else if (o.kind === "error" && restartingSince.current === null) {
        const pollError = toCardError(o.error);
        setState((s) => ({ ...s, pollError }));
      }
    },
  );

  const status = state.status;
  const view: MoveInView | null = status ? phaseView(status) : null;
  const first =
    status !== null && (status.phase !== "none" || status.blocker === null);
  useEffect(() => onFirst(first), [first, onFirst]);

  async function write(
    action: NonNullable<InState["action"]>,
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    setState((s) => ({ ...s, action, error: null, errorCheck: null }));
    try {
      const answer = await apiFetch<unknown>(method, path, body);
      setState((s) => ({ ...s, action: null }));
      return answer;
    } catch (e) {
      setState((s) => ({
        ...s,
        action: null,
        error: toCardError(e),
        // The card the click came from: a poll may have moved the status on
        // while the write was in flight.
        errorCheck: view?.kind === "confirm" ? view.preflightId : null,
      }));
      return null;
    } finally {
      refresh();
    }
  }

  async function start() {
    setState((s) => ({ ...s, cancelled: null }));
    const answer = await write("start", "POST", "/api/office/move-in", {
      code: state.code.trim(),
    });
    if (answer) setState((s) => ({ ...s, code: "" }));
  }

  async function cancel() {
    const answer = (await write(
      "cancel",
      "DELETE",
      "/api/office/move-in",
    )) as MoveInCancelRes | null;
    if (answer) setState((s) => ({ ...s, cancelled: answer }));
  }

  async function finish() {
    const accept = view?.kind === "incomplete" && state.acceptMissing;
    const answer = await write(
      "finish",
      "POST",
      "/api/office/move-in/finish",
      accept ? { acceptMissing: true } : {},
    );
    if (answer) restartingSince.current ??= Date.now();
  }

  const busy = state.action !== null;
  const lockedNote =
    (confirm.armed === "cancel" &&
      view !== null &&
      "oldOfficeLocked" in view &&
      view.oldOfficeLocked) ||
    state.cancelled?.oldOfficeLocked === true;

  const cancelButton = (
    <button
      data-testid="move-in-cancel"
      {...confirm.bind("cancel")}
      disabled={busy}
      onClick={() => confirm.confirm("cancel", () => void cancel())}
      style={{
        ...secondaryBtn,
        ...(confirm.armed === "cancel" ? armedConfirmLook : {}),
      }}
    >
      {t(
        confirm.armed === "cancel"
          ? "common.confirmQuestion"
          : "officeMove.in.cancel",
      )}
    </button>
  );

  const size = (bytes: number) => sizeText(language, t, bytes);
  const count = (n: number) => formatNumber(language, n);
  const time = (ts: number) => absoluteTime(language, ts);

  return (
    <section
      data-testid="move-in"
      {...(view ? { "data-view": view.kind } : {})}
      style={{ ...cardStyle, marginTop: 16 }}
    >
      <h4 style={heading}>
        {view?.kind === "report"
          ? t("officeMove.report.heading")
          : t("officeMove.in.heading")}
      </h4>
      {/* The report names the old office in its first line. */}
      {view && view.kind !== "start" && view.kind !== "report" && (
        <p style={{ ...hint, margin: "4px 0 0" }}>
          {t("officeMove.in.from", { origin: view.oldOrigin })}
        </p>
      )}
      {/* Before the first status, the start controls show disabled. */}
      {(view === null || view.kind === "start") && (
        <StartView
          blocker={view?.blocker ?? null}
          loading={view === null}
          code={state.code}
          busy={busy}
          onCode={(code) => setState((s) => ({ ...s, code }))}
          onStart={() => void start()}
        />
      )}
      {view?.kind === "working" && (
        <>
          <p style={text}>{t(`officeMove.in.step.${view.step}`)}</p>
          <div style={row}>{cancelButton}</div>
        </>
      )}
      {view?.kind === "confirm" && (
        <>
          <ConfirmView
            preflight={view.preflight}
            outside={view.outside}
            size={size}
            time={time}
          />
          {view.live && <LiveLine live={view.live} size={size} time={time} />}
          <div style={row}>
            {/* After a refusal for an old or changed check, a new check
                comes first. */}
            {state.error?.detail?.code === "preflight_stale" ||
            state.error?.detail?.code === "turns_changed" ||
            state.error?.detail?.code === "folders_changed" ? (
              <>
                <CheckAgain busy={busy} onClick={() => void checkAgain()} />
                <LockButton
                  view={view}
                  busy={busy}
                  onLock={() => void lock(view.preflightId)}
                />
              </>
            ) : (
              <>
                <LockButton
                  view={view}
                  busy={busy}
                  onLock={() => void lock(view.preflightId)}
                />
                <CheckAgain busy={busy} onClick={() => void checkAgain()} />
              </>
            )}
            {view.live?.copyAgain && (
              <button
                data-testid="move-copy-again"
                disabled={busy}
                onClick={() =>
                  void write("live", "POST", "/api/office/move-in/live")
                }
                style={secondaryBtn}
              >
                {t("officeMove.in.copyAgain")}
              </button>
            )}
            {cancelButton}
          </div>
        </>
      )}
      {view?.kind === "copying" && (
        <>
          <p style={text}>
            {view.checking
              ? t("officeMove.in.checking")
              : view.progress
                ? t("officeMove.in.copying", {
                    done: size(copiedBytes(view.progress)),
                    total: size(view.progress.totalBytes),
                  })
                : t("officeMove.in.copyingStart")}
          </p>
          {view.fraction !== null && (
            <progress
              value={view.fraction}
              max={1}
              style={{ width: "100%", marginTop: 6 }}
            />
          )}
          {!view.checking && (view.progress?.filesKept ?? 0) > 0 && (
            <p data-testid="move-kept" style={hint}>
              {tn("officeMove.in.kept", view.progress!.filesKept!, {
                size: size(view.progress!.bytesKept ?? 0),
              })}
            </p>
          )}
          <div style={row}>{cancelButton}</div>
        </>
      )}
      {(view?.kind === "staged" || view?.kind === "incomplete") && (
        <>
          {view.kind === "staged" ? (
            <p style={text}>
              {t("officeMove.in.staged", {
                files: count(view.result.files),
                size: size(view.result.bytes),
              })}
            </p>
          ) : (
            <>
              <p style={warning}>
                {tn("officeMove.in.incomplete", view.result.missing.length)}
              </p>
              <PathList items={view.result.missing} />
              <label style={{ ...text, display: "flex", gap: 6 }}>
                <input
                  data-testid="move-accept-missing"
                  type="checkbox"
                  checked={state.acceptMissing}
                  onChange={(e) => {
                    const acceptMissing = e.currentTarget.checked;
                    setState((s) => ({ ...s, acceptMissing }));
                  }}
                />
                {t("officeMove.in.acceptMissing")}
              </label>
            </>
          )}
          {view.error && <ErrorLine error={view.error} />}
          <p style={text}>{t("officeMove.in.finishWarning")}</p>
          <div style={row}>
            <button
              data-testid="move-finish"
              {...confirm.bind("finish")}
              disabled={busy || !finishAllowed(view, state.acceptMissing)}
              onClick={() => confirm.confirm("finish", () => void finish())}
              style={{
                ...primaryBtn,
                ...(confirm.armed === "finish" ? armedConfirmLook : {}),
              }}
            >
              {t(
                confirm.armed === "finish"
                  ? "common.confirmQuestion"
                  : "officeMove.in.finish",
              )}
            </button>
            {cancelButton}
          </div>
        </>
      )}
      {view?.kind === "failed" && (
        <>
          <p style={warning}>{t("officeMove.in.failed")}</p>
          {/* With the folder checks, the blocked folders (why and the fix)
              replace the server's message, which is stale once they are
              fixed. */}
          {view.outside.length > 0 ? (
            <BlockedFolders lines={view.outside} />
          ) : (
            <ErrorLine error={view.error} />
          )}
          <div style={row}>
            {view.retryable && (
              <button
                data-testid="move-retry"
                disabled={busy}
                onClick={() =>
                  void write("pull", "POST", "/api/office/move-in/pull")
                }
                style={primaryBtn}
              >
                {t("officeMove.in.tryAgain")}
              </button>
            )}
            {cancelButton}
          </div>
        </>
      )}
      {view?.kind === "restarting" && (
        <>
          <p style={text}>{t("officeMove.in.restarting")}</p>
          {state.lost && (
            <div data-testid="move-lost" style={row}>
              <span style={warning}>{t("officeMove.in.lost")}</span>
              <button onClick={() => reloadBrowser()} style={secondaryBtn}>
                {t("officeMove.in.reload")}
              </button>
            </div>
          )}
        </>
      )}
      {view?.kind === "report" && (
        <ReportView
          view={view}
          armed={confirm.armed === "aside"}
          size={size}
          time={time}
          deleteButton={
            <button
              data-testid="move-aside-delete"
              {...confirm.bind("aside")}
              disabled={busy}
              onClick={() => confirm.confirm("aside", () => void cancel())}
              style={{
                ...secondaryBtn,
                ...(confirm.armed === "aside" ? armedConfirmLook : {}),
              }}
            >
              {t(
                confirm.armed === "aside"
                  ? "common.confirmQuestion"
                  : "officeMove.report.asideDelete",
              )}
            </button>
          }
        />
      )}
      {lockedNote && (
        <p data-testid="move-locked-note" style={warning}>
          {t("officeMove.in.lockedNote")}
        </p>
      )}
      {/* Restart errors are the restart itself, not a failure. */}
      {view?.kind !== "restarting" && (
        <ErrorLine error={state.error ?? state.pollError} />
      )}
      {state.error && <BoxesLine detail={state.error.detail} />}
    </section>
  );

  async function lock(preflightId: string) {
    await write("lock", "POST", "/api/office/move-in/lock", { preflightId });
  }
  async function checkAgain() {
    await write("preflight", "POST", "/api/office/move-in/preflight");
  }
}

function StartView({
  blocker,
  loading,
  code,
  busy,
  onCode,
  onStart,
}: {
  blocker: MoveInStartBlocker | null;
  /** No status yet: the controls show disabled. */
  loading: boolean;
  code: string;
  busy: boolean;
  onCode: (code: string) => void;
  onStart: () => void;
}) {
  const { t, tn } = useI18n();
  if (blocker) {
    const reasons = notFreshReasons(blocker);
    return (
      <div data-testid="move-blocker">
        {reasons ? (
          <>
            <p style={text}>{t("officeMove.in.blocked")}</p>
            <ul style={list}>
              {reasons.map((r) => (
                <li key={r.kind}>
                  {tn(`officeMove.in.reason.${r.kind}`, r.count)}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p style={text}>{blocker.message}</p>
        )}
      </div>
    );
  }
  return (
    <>
      <p style={text}>{t("officeMove.in.body")}</p>
      <form
        style={row}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy && !loading) onStart();
        }}
      >
        <input
          data-testid="move-in-code"
          aria-label={t("officeMove.in.codeLabel")}
          placeholder={t("officeMove.in.codeLabel")}
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
          value={code}
          onChange={(e) => onCode(e.currentTarget.value)}
          style={{
            ...mono,
            flex: "1 1 240px",
            minWidth: 0,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
          }}
        />
        <button
          data-testid="move-in-start"
          type="submit"
          disabled={loading || busy || !code.trim()}
          style={primaryBtn}
        >
          {t("officeMove.in.start")}
        </button>
      </form>
    </>
  );
}

type ReasonKind = "users" | "agents" | "apps" | "tasks";

/** The not-fresh reasons with counts, or null for another blocker. */
function notFreshReasons(
  blocker: MoveInStartBlocker,
): { kind: ReasonKind; count: number }[] | null {
  const raw = blocker.extra?.reasons;
  if (blocker.code !== "office_not_fresh" || !Array.isArray(raw)) return null;
  const out: { kind: ReasonKind; count: number }[] = [];
  for (const r of raw as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const { kind, count } = r as { kind?: unknown; count?: unknown };
    if (
      (kind === "users" ||
        kind === "agents" ||
        kind === "apps" ||
        kind === "tasks") &&
      typeof count === "number"
    )
      out.push({ kind, count });
  }
  return out.length > 0 ? out : null;
}

/** The copy while the old office still runs (slice 4), by phase. */
function LiveLine({
  live,
  size,
  time,
}: {
  live: LiveView;
  size: (bytes: number) => string;
  time: (ts: number) => string;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="move-live" data-phase={live.phase}>
      {live.phase === "manifest" && (
        <p style={text}>{t("officeMove.in.live.manifest")}</p>
      )}
      {live.phase === "copying" && (
        <>
          <p style={text}>
            {live.progress
              ? t("officeMove.in.live.copying", {
                  done: size(copiedBytes(live.progress)),
                  total: size(live.progress.totalBytes),
                })
              : t("officeMove.in.live.manifest")}
          </p>
          {live.fraction !== null && (
            <progress
              value={live.fraction}
              max={1}
              style={{ width: "100%", marginTop: 6 }}
            />
          )}
        </>
      )}
      {(live.phase === "manifest" || live.phase === "copying") && (
        <p style={hint}>{t("officeMove.in.live.lockStops")}</p>
      )}
      {live.phase === "ready" && live.finishedAt !== null && (
        <p style={text}>
          {t("officeMove.in.live.ready", { time: time(live.finishedAt) })}
        </p>
      )}
      {live.phase === "stopped" && (
        <p style={text}>{t("officeMove.in.live.stopped")}</p>
      )}
      {live.phase === "failed" && (
        <>
          <p style={warning}>{t("officeMove.in.live.failed")}</p>
          <ErrorLine error={live.error} />
        </>
      )}
      {live.phase === "unsupported" && (
        <p style={text}>{t("officeMove.in.live.unsupported")}</p>
      )}
    </div>
  );
}

function LockButton({
  view,
  busy,
  onLock,
}: {
  view: Extract<MoveInView, { kind: "confirm" }>;
  busy: boolean;
  onLock: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      data-testid="move-lock"
      disabled={busy || !view.lockAllowed}
      onClick={onLock}
      style={primaryBtn}
    >
      {t("officeMove.in.lock")}
    </button>
  );
}

function CheckAgain({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      data-testid="move-check-again"
      disabled={busy}
      onClick={onClick}
      style={secondaryBtn}
    >
      {t("officeMove.in.checkAgain")}
    </button>
  );
}

function ConfirmView({
  preflight: p,
  outside,
  size,
  time,
}: {
  preflight: PreflightView;
  outside: OutsideFolderLine[];
  size: (bytes: number) => string;
  time: (ts: number) => string;
}) {
  const { t } = useI18n();
  // Slice 5b: the folders outside the home are copied too.
  const outsideBytes = outside.reduce((n, l) => n + (l.bytes ?? 0), 0);
  const sizePartial =
    p.sizes.kind === "total" &&
    (p.sizes.partial || outside.some((l) => l.bytes === null));
  return (
    <>
      <p style={{ ...text, fontWeight: 600 }}>
        {t("officeMove.in.confirm.heading")}
      </p>
      <p style={text}>{t("officeMove.in.confirm.body")}</p>
      {p.finishedAt !== null && (
        <p style={hint}>
          {t("officeMove.in.confirm.checkedAt", { time: time(p.finishedAt) })}
        </p>
      )}
      {p.restart.kind === "set" && p.restart.restart !== "always" && (
        <p style={warning}>
          {t("officeMove.in.confirm.restartOff", { unit: p.restart.unit })}
        </p>
      )}
      {p.restart.kind === "none" && (
        <p style={warning}>{t("officeMove.in.confirm.restartNone")}</p>
      )}
      {p.restart.kind === "unknown" && (
        <p style={warning}>{t("officeMove.in.confirm.restartUnknown")}</p>
      )}
      {p.memberOsUsers.kind === "list" && (
        <p data-testid="move-member-os-users" style={warning}>
          {t("officeMove.in.confirm.memberOsUsers", {
            names: p.memberOsUsers.names.join(", "),
          })}
        </p>
      )}
      {p.memberOsUsers.kind === "broken" && (
        <p data-testid="move-member-os-users" style={warning}>
          {t("officeMove.in.confirm.memberOsUsersBroken")}
        </p>
      )}
      <p style={text}>
        {p.turnsInFlight.kind === "unknown"
          ? t("officeMove.in.confirm.turnsUnknown")
          : p.turnsInFlight.agents.length === 0
            ? t("officeMove.in.confirm.noTurns")
            : t("officeMove.in.confirm.turns", {
                names: p.turnsInFlight.agents
                  .map((a) =>
                    a.roomName ? `${a.name} (${a.roomName})` : a.name,
                  )
                  .join(", "),
              })}
      </p>
      {p.units.kind === "list" ? (
        p.units.units.length > 0 && (
          <p style={text}>
            {t("officeMove.in.confirm.units", {
              names: p.units.units.map((u) => u.name).join(", "),
            })}
          </p>
        )
      ) : (
        <p style={text}>{t("officeMove.in.confirm.unitsUnknown")}</p>
      )}
      {p.hostRefs.kind === "list" && p.hostRefs.apps.length > 0 && (
        <>
          <p style={text}>{t("officeMove.in.confirm.hostRefs")}</p>
          <ul style={list}>
            {p.hostRefs.apps.map((a) => (
              <li key={a.app}>
                {a.app}: <span style={mono}>{a.paths.join(", ")}</span>
                {(a.truncated || a.timedOut) &&
                  ` ${t("officeMove.in.confirm.hostRefsMore")}`}
              </li>
            ))}
          </ul>
        </>
      )}
      {p.sizes.kind === "total" && (
        <p style={text}>
          {t(
            sizePartial
              ? "officeMove.in.confirm.sizeAtLeast"
              : "officeMove.in.confirm.size",
            { size: size(p.sizes.bytes + outsideBytes) },
          )}
        </p>
      )}
      {outside.length > 0 && (
        <>
          <p style={text}>{t("officeMove.in.outside.heading")}</p>
          <FolderList testId="move-outside" lines={outside} size={size} />
          {outside.some((l) => !l.check.ok) && (
            <p style={warning}>{t("officeMove.in.outside.lockWaits")}</p>
          )}
        </>
      )}
      {p.outside.kind === "list" && p.outside.left.length > 0 && (
        <>
          <p style={text}>{t("officeMove.in.outside.left")}</p>
          <LeftFolders testId="move-outside-left" items={p.outside.left} />
        </>
      )}
      {p.sudoPackages.kind === "list" ? (
        p.sudoPackages.packages.length > 0 && (
          <p style={text}>
            {t("officeMove.in.confirm.sudo", {
              packages: p.sudoPackages.packages.join(", "),
            })}
          </p>
        )
      ) : (
        <p style={hint}>{t("officeMove.in.confirm.sudoUnknown")}</p>
      )}
    </>
  );
}

/** Slice 5b: the folders outside the home, one item per folder with its
 *  size and, when it cannot land here, why and the root command. */
function FolderList({
  testId,
  lines,
  size,
}: {
  testId: string;
  lines: OutsideFolderLine[];
  size?: (bytes: number) => string;
}) {
  const { t } = useI18n();
  // The cap never hides a folder that cannot land (the owner must see why):
  // it drops only folders that can, and keeps the checks' order.
  const blocked = lines.filter((l) => !l.check.ok).length;
  let room = Math.max(0, MOVE_LIST_MAX - blocked);
  const shown = lines.filter((l) => !l.check.ok || room-- > 0);
  const more = lines.length - shown.length;
  return (
    <ul data-testid={testId} style={list}>
      {shown.map((l) => (
        <li key={l.path} data-path={l.path}>
          <span style={mono}>{l.path}</span>
          {size &&
            ` (${l.bytes === null ? t("officeMove.in.outside.sizeUnknown") : size(l.bytes)})`}
          {!l.check.ok && (
            <>
              <div data-testid="move-outside-blocked" style={warning}>
                {t(BLOCK_REASON_KEY[l.check.reason], { at: l.check.at })}
              </div>
              {l.check.command && <RootCommand command={l.check.command} />}
            </>
          )}
        </li>
      ))}
      {more > 0 && <li>{t("officeMove.in.more", { count: more })}</li>}
    </ul>
  );
}

function RootCommand({ command }: { command: string }) {
  const { t } = useI18n();
  return (
    <div style={{ margin: "4px 0" }}>
      <span style={hint}>{t("officeMove.in.outside.command")}</span>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <code
          data-testid="move-outside-command"
          style={{
            ...mono,
            flex: 1,
            minWidth: 0,
            overflowWrap: "anywhere",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-base)",
          }}
        >
          {command}
        </code>
        <CopyButton getText={() => command} />
      </div>
    </div>
  );
}

/** Slice 5b: a pass failed for folders outside the home: the ones that
 *  cannot land here yet, until the owner fixes them. */
function BlockedFolders({ lines }: { lines: OutsideFolderLine[] }) {
  const { t } = useI18n();
  const blocked = lines.filter((l) => !l.check.ok);
  if (blocked.length === 0) return null;
  return (
    <>
      <p style={text}>{t("officeMove.in.outside.fixFirst")}</p>
      <FolderList testId="move-outside" lines={blocked} />
    </>
  );
}

/** Slice 5b: the copy of each reason a folder cannot land here. */
const BLOCK_REASON_KEY = {
  in_home: "officeMove.in.outside.reason.inHome",
  link: "officeMove.in.outside.reason.link",
  not_dir: "officeMove.in.outside.reason.notDir",
  owner: "officeMove.in.outside.reason.owner",
  unsafe_parent: "officeMove.in.outside.reason.unsafeParent",
  not_empty: "officeMove.in.outside.reason.notEmpty",
  no_write: "officeMove.in.outside.reason.noWrite",
} as const satisfies Record<MoveInFolderBlock, string>;

/** Slice 5b: the copy of each reason the old office leaves a folder. */
const LEFT_REASON_KEY = {
  temp: "officeMove.in.outside.leftReason.temp",
  link: "officeMove.in.outside.leftReason.link",
  office: "officeMove.in.outside.leftReason.office",
  owner: "officeMove.in.outside.leftReason.owner",
} as const satisfies Record<MoveOutsideLeftReason, string>;

const leftReasonKey = (reason: string) =>
  Object.hasOwn(LEFT_REASON_KEY, reason)
    ? LEFT_REASON_KEY[reason as MoveOutsideLeftReason]
    : null;

/** Slice 5b: the folders outside the home the old office leaves, with why
 *  (a reason this release does not name shows the path only). */
function LeftFolders({
  testId,
  items,
}: {
  testId: string;
  items: { path: string; reason: string }[];
}) {
  const { t } = useI18n();
  const { shown, more } = listHead(items);
  return (
    <ul data-testid={testId} style={list}>
      {shown.map((f) => {
        const reason = leftReasonKey(f.reason);
        return (
          <li key={f.path} data-path={f.path}>
            <span style={mono}>{f.path}</span>
            {reason !== null && ` (${t(reason)})`}
          </li>
        );
      })}
      {more > 0 && <li>{t("officeMove.in.more", { count: more })}</li>}
    </ul>
  );
}

function PathList({ items }: { items: { path: string; reason: string }[] }) {
  const { t } = useI18n();
  const { shown, more } = listHead(items);
  return (
    <ul style={list}>
      {shown.map((m) => (
        <li key={m.path}>
          <span style={mono}>{m.path}</span> ({m.reason})
        </li>
      ))}
      {more > 0 && <li>{t("officeMove.in.more", { count: more })}</li>}
    </ul>
  );
}

function ReportView({
  view,
  armed,
  size,
  time,
  deleteButton,
}: {
  view: Extract<MoveInView, { kind: "report" }>;
  armed: boolean;
  size: (bytes: number) => string;
  time: (ts: number) => string;
  deleteButton: React.ReactNode;
}) {
  const { t, tn, rich } = useI18n();
  const r = view.report;
  const aside = listHead(r.aside.entries);
  // Slice 5b: absent in a report of an earlier release.
  const outsideMoved = listHead(r.outsideMoved ?? []);
  const leftBehind = leftBehindLines(r);
  const leftBehindText = (line: LeftBehindLine): string => {
    switch (line.kind) {
      case "unit":
        return tn("officeMove.report.excludedItem", line.entries, {
          unit: line.unit,
        });
      case "secrets":
        return tn("officeMove.report.secrets", line.count);
      default:
        return t(`officeMove.report.leftBehind.${line.kind}`);
    }
  };
  return (
    <>
      <p style={text}>
        {t("officeMove.report.from", {
          origin: view.oldOrigin,
          time: time(r.swappedAt),
          name: r.by.name ?? r.by.id,
        })}
      </p>
      {r.ownerRenamedTo && (
        <p style={text}>
          {t("officeMove.report.renamed", { name: r.ownerRenamedTo })}
        </p>
      )}
      {r.missing.length > 0 && (
        <>
          <p style={text}>
            {tn("officeMove.report.missing", r.missing.length)}
          </p>
          <PathList items={r.missing} />
        </>
      )}
      {leftBehind.length > 0 && (
        <>
          <p style={text}>{t("officeMove.report.excluded")}</p>
          <ul data-testid="move-left-behind" style={list}>
            {leftBehind.map((line) => (
              <li key={line.kind === "unit" ? `unit:${line.unit}` : line.kind}>
                {leftBehindText(line)}
              </li>
            ))}
          </ul>
        </>
      )}
      {outsideMoved.shown.length > 0 && (
        <>
          <p style={text}>{t("officeMove.report.outsideMoved")}</p>
          <ul data-testid="move-report-outside-moved" style={list}>
            {outsideMoved.shown.map((path) => (
              <li key={path} data-path={path} style={mono}>
                {path}
              </li>
            ))}
            {outsideMoved.more > 0 && (
              <li>{t("officeMove.in.more", { count: outsideMoved.more })}</li>
            )}
          </ul>
        </>
      )}
      {r.outsideLeft && r.outsideLeft.length > 0 && (
        <>
          <p style={text}>{t("officeMove.report.outsideLeft")}</p>
          <LeftFolders
            testId="move-report-outside-left"
            items={r.outsideLeft}
          />
        </>
      )}
      {r.oldOfficeUnitSetAside && (
        <p style={text}>
          {t("officeMove.report.unitSetAside", {
            name: r.oldOfficeUnitSetAside,
          })}
        </p>
      )}
      {r.units === null ? (
        <p style={text}>{t("officeMove.report.unitsPending")}</p>
      ) : (
        <>
          {r.units.restored.length > 0 && (
            <p style={text}>
              {t("officeMove.report.unitsRestored", {
                names: r.units.restored.join(", "),
              })}
            </p>
          )}
          {r.units.failed.map((f) => (
            <p key={f.name} style={warning}>
              {t("officeMove.report.unitFailed", {
                name: f.name,
                reason: f.reason,
              })}
            </p>
          ))}
        </>
      )}
      <p style={text}>
        {rich("officeMove.report.aside", {
          path: (
            <span data-testid="move-aside-path" style={mono}>
              {view.asidePath}
            </span>
          ),
          size: size(r.aside.bytes),
        })}
      </p>
      <ul style={list}>
        {aside.shown.map((e) => (
          <li key={e} data-testid="move-aside-entry" style={mono}>
            {e}
          </li>
        ))}
        {aside.more > 0 && (
          <li data-testid="move-aside-more">
            {t("officeMove.in.more", { count: aside.more })}
          </li>
        )}
      </ul>
      {/* The warning comes after the button, so the armed button stays
          under the pointer for the second click. */}
      <div style={row}>{deleteButton}</div>
      {armed && (
        <p style={warning}>{t("officeMove.report.asideDeleteWarning")}</p>
      )}
    </>
  );
}

/** A refusal that carries both boxes (ours: the old office, theirs: this
 *  office) shows the values that differ. */
function BoxesLine({ detail }: { detail?: Record<string, unknown> }) {
  const { t } = useI18n();
  const old = asBox(detail?.ours);
  const here = asBox(detail?.theirs);
  if (!old || !here) return null;
  const parts = (b: MoveBoxInfo) =>
    [
      `${t("officeMove.in.boxHome")} ${b.homePath}`,
      `${t("officeMove.in.boxData")} ${b.stateRoot}`,
      `${t("officeMove.in.boxVersion")} ${versionOf(b)}`,
    ].join(", ");
  return (
    <p style={{ ...hint, ...mono }}>
      {t("officeMove.in.boxes", { old: parts(old), here: parts(here) })}
    </p>
  );
}

function asBox(v: unknown): MoveBoxInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  return typeof b.homePath === "string" && typeof b.stateRoot === "string"
    ? {
        homePath: b.homePath,
        stateRoot: b.stateRoot,
        release: typeof b.release === "string" ? b.release : null,
        commit: typeof b.commit === "string" ? b.commit : null,
      }
    : null;
}
