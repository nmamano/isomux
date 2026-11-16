import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, apiFetch } from "../api.ts";
import type {
  MemberOsUserWire,
  MemberTokenViewRes,
  MemberUserUnsupported,
} from "../../shared/contract-shapes.ts";
import { CopyButton } from "./CopyButton.tsx";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";

// Settings > Members > a member > Own OS user (server/member-os-user-view.ts,
// internal-docs/member-os-user-design.md 2.1): an office owner turns it on or
// off with one root command, shown here to copy. Where the command cannot
// run, only the reason shows; nothing renders when the read fails or the
// answer has no support field.
//
// The page reads the state again every 3 s while it can still change: while
// the command runs, and after a Copy until the state changes. It stops on
// unmount, on a final state, and after the command's own bound of 3 hours.
export const OS_USER_POLL_MS = 3000;
export const OS_USER_POLL_CAP_MS = 3 * 60 * 60_000;

export function MemberOsUserSection({
  username,
  headingStyle,
  hintStyle,
}: {
  username: string;
  headingStyle: CSSProperties;
  hintStyle: CSSProperties;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<MemberOsUserWire | null>(null);
  const [token, setToken] = useState<MemberTokenViewRes | null>(null);
  // Set at a Copy: the state then, until the page sees another.
  const [waitingFrom, setWaitingFrom] = useState<string | null>(null);
  const pollStart = useRef<number | null>(null);
  // The last Run's refusal, shown under the commands.
  const [runError, setRunError] = useState<string | null>(null);
  const route = `/api/users/${encodeURIComponent(username)}/os-user`;

  // Run (4c-iii): the server runs the command as root with the password;
  // the end shows through the GET's attempt.
  const runCommand = async (
    action: "enable" | "disable",
    password: string | null,
  ): Promise<boolean> => {
    setRunError(null);
    try {
      await apiFetch(
        "POST",
        `${route}/run`,
        password === null ? { action } : { action, password },
      );
    } catch (err) {
      setRunError(runErrorLine(err, t));
      return false;
    }
    try {
      setView(await apiFetch<MemberOsUserWire>("GET", route));
    } catch {
      // The poll reads it again.
    }
    return true;
  };

  useEffect(() => {
    let live = true;
    apiFetch<MemberOsUserWire>("GET", route)
      .then((next) => live && setView(next))
      .catch(() => live && setView(null));
    apiFetch<MemberTokenViewRes>("GET", "/api/office/claude-member-token")
      .then((next) => live && setToken(next))
      .catch(() => live && setToken(null));
    return () => {
      live = false;
    };
  }, [route]);

  const fingerprint = view ? stateKey(view) : null;
  const running = view?.attempt?.status === "running";
  const waiting = waitingFrom !== null && waitingFrom === fingerprint;
  const polling = !!view?.support?.ok && (running || waiting);

  useEffect(() => {
    if (waitingFrom !== null && fingerprint !== waitingFrom)
      setWaitingFrom(null);
  }, [fingerprint, waitingFrom]);

  useEffect(() => {
    if (!polling) {
      pollStart.current = null;
      return;
    }
    pollStart.current ??= Date.now();
    let live = true;
    const timer = setInterval(() => {
      if (Date.now() - (pollStart.current ?? 0) > OS_USER_POLL_CAP_MS) {
        clearInterval(timer);
        setWaitingFrom(null);
        return;
      }
      apiFetch<MemberOsUserWire>("GET", route)
        .then((next) => live && setView(next))
        .catch(() => {});
    }, OS_USER_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [polling, route]);

  // No support: a server older than this page (a UI build is live before
  // the restart that brings its server).
  if (!view?.support) return null;
  if (!view.support.ok)
    return (
      <div data-testid="member-os-user">
        <h5 style={headingStyle}>{t("settings.osUser.title")}</h5>
        <p style={hintStyle}>{t("settings.osUser.hint")}</p>
        <p
          data-testid="member-os-user-unsupported"
          data-reason={view.support.reason}
          style={{
            fontSize: 13,
            margin: "6px 0",
            color: "var(--text-primary)",
          }}
        >
          {t(UNSUPPORTED_KEY[view.support.reason])}
        </p>
      </div>
    );

  // Off: turn it on. Not ready: an enable that the office's restart cut
  // finishes when it runs again, so both. Otherwise: turn it off.
  const commands: {
    hint: string;
    line: string;
    action: "enable" | "disable";
  }[] =
    view.commands === null
      ? []
      : view.state === "off"
        ? [
            {
              hint: t("settings.osUser.enableHint"),
              line: view.commands.enable,
              action: "enable",
            },
          ]
        : view.state === "not_ready"
          ? [
              {
                hint: view.unfinished
                  ? t("settings.osUser.finishHint")
                  : t("settings.osUser.rerunHint"),
                line: view.commands.enable,
                action: "enable",
              },
              {
                hint: t("settings.osUser.disableHint"),
                line: view.commands.disable,
                action: "disable",
              },
            ]
          : [
              {
                hint: t("settings.osUser.disableHint"),
                line: view.commands.disable,
                action: "disable",
              },
            ];

  return (
    <div data-testid="member-os-user">
      <h5 style={headingStyle}>{t("settings.osUser.title")}</h5>
      <p style={hintStyle}>{t("settings.osUser.hint")}</p>
      <p
        data-testid="member-os-user-state"
        data-state={view.state}
        style={{ fontSize: 13, margin: "6px 0", color: "var(--text-primary)" }}
      >
        {stateLine(view, t)}
      </p>
      {view.attempt && (
        <p
          data-testid="member-os-user-attempt"
          data-status={view.attempt.status}
          style={{
            fontSize: 12,
            margin: "4px 0",
            color:
              view.attempt.status === "running"
                ? "var(--text-muted)"
                : "var(--red-text)",
          }}
        >
          {attemptLine(view.attempt, t)}
        </p>
      )}
      {waiting && !running && (
        <p
          data-testid="member-os-user-waiting"
          style={{ fontSize: 12, margin: "4px 0", color: "var(--text-muted)" }}
        >
          {t("settings.osUser.waiting")}
        </p>
      )}
      {commands.map(({ hint, line: command, action }) => (
        <div key={command}>
          <p style={{ ...hintStyle, marginTop: 8 }}>{hint}</p>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              marginTop: 4,
            }}
          >
            <code
              data-testid="member-os-user-command"
              style={{
                flex: 1,
                minWidth: 0,
                overflowWrap: "anywhere",
                fontSize: 12,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-base)",
              }}
            >
              {command}
            </code>
            <CopyButton
              getText={() => {
                setWaitingFrom(fingerprint);
                return command;
              }}
            />
          </div>
          {view.run && (
            <RunControl
              withPassword={view.run === "password"}
              blocked={running}
              onRun={(password) => runCommand(action, password)}
            />
          )}
        </div>
      ))}
      {runError && (
        <p
          data-testid="member-os-user-run-error"
          role="alert"
          style={{ fontSize: 12, margin: "4px 0", color: "var(--red-text)" }}
        >
          {runError}
        </p>
      )}
      {view.commandHint === "container_name" && commands.length > 0 && (
        <p data-testid="member-os-user-command-hint" style={hintStyle}>
          {t("settings.osUser.containerName")}
        </p>
      )}
      <p
        data-testid="member-os-user-claude"
        style={{ ...hintStyle, marginTop: 10 }}
      >
        {token?.set
          ? t("settings.osUser.claudeTokenSet")
          : t("settings.osUser.claudeTokenMissing")}{" "}
        <a
          href="/integrations/providers"
          style={{ color: "inherit", textDecoration: "underline" }}
        >
          {t("settings.osUser.claudeTokenLink")}
        </a>
      </p>
      <p data-testid="member-os-user-codex" style={hintStyle}>
        {t("settings.osUser.codexOff")}
      </p>
    </div>
  );
}

// Run beside a command: a password field where sudo asks for one. The
// password is sent once and never kept: the field is cleared after a start.
function RunControl({
  withPassword,
  blocked,
  onRun,
}: {
  withPassword: boolean;
  blocked: boolean;
  onRun: (password: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const disabled = blocked || sending || (withPassword && password === "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setSending(true);
        void onRun(withPassword ? password : null).then((started) => {
          setSending(false);
          if (started) setPassword("");
        });
      }}
      style={{ display: "flex", gap: 6, marginTop: 6 }}
    >
      {withPassword && (
        <input
          data-testid="member-os-user-password"
          type="password"
          autoComplete="off"
          aria-label={t("cards.sudoRequest.password")}
          placeholder={t("cards.sudoRequest.password")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ ...dialogInput, flex: 1, minWidth: 0 }}
        />
      )}
      <button
        data-testid="member-os-user-run"
        type="submit"
        disabled={disabled}
        style={dialogSaveBtn}
      >
        {sending ? t("cards.sudoRequest.running") : t("cards.sudoRequest.run")}
      </button>
    </form>
  );
}

// A Run refusal in words: a wrong password says sudo's line and the tries
// left; a lock says when to try again.
function runErrorLine(err: unknown, t: T): string {
  if (!(err instanceof ApiError)) return t("cards.sudoRequest.runFailed");
  const detail = err.detail ?? {};
  switch (err.code) {
    case "not_started":
      return t("cards.sudoRequest.notStarted", {
        attempts: String(
          typeof detail.attemptsLeft === "number" ? detail.attemptsLeft : 0,
        ),
        reason: typeof detail.reason === "string" ? detail.reason : "",
      });
    case "locked_out":
      return t("settings.osUser.runLocked", {
        minutes: String(
          Math.max(1, Math.ceil(Number(detail.retryAfterS ?? 900) / 60)),
        ),
      });
    case "invalid_password":
      return t("cards.sudoRequest.invalidPassword");
    case "run_in_progress":
      return t("settings.osUser.runInProgress");
    default:
      // The server's message is English: a refusal without its own line
      // gets the sudo card's, as SudoAskCard does.
      return t("cards.sudoRequest.runFailed");
  }
}

const UNSUPPORTED_KEY = {
  not_linux: "settings.osUser.unsupported.notLinux",
  kubernetes: "settings.osUser.unsupported.kubernetes",
  render: "settings.osUser.unsupported.render",
  no_system_install: "settings.osUser.unsupported.noSystemInstall",
  no_command: "settings.osUser.unsupported.noCommand",
} as const satisfies Record<MemberUserUnsupported, string>;

// What can change while the page waits: the state, the OS user, the attempt.
function stateKey(view: MemberOsUserWire): string {
  return JSON.stringify([
    view.state,
    view.osUser?.name ?? null,
    view.attempt?.status ?? null,
    view.attempt?.at ?? null,
  ]);
}

type T = ReturnType<typeof useI18n>["t"];

function stateLine(view: MemberOsUserWire, t: T): string {
  const name = view.osUser?.name ?? "";
  switch (view.state) {
    case "off":
      return t("settings.osUser.off");
    case "on":
      return t("settings.osUser.on", { name });
    case "moving":
      return t("settings.osUser.moving", { name });
    case "not_ready":
      return view.unfinished
        ? t("settings.osUser.unfinished", { name })
        : t("settings.osUser.notReady", { name });
    case "broken":
      return t("settings.osUser.broken", { reason: view.reason ?? "" });
  }
}

function attemptLine(
  attempt: NonNullable<MemberOsUserWire["attempt"]>,
  t: T,
): string {
  if (attempt.status === "running")
    return attempt.action === "enable"
      ? t("settings.osUser.turningOn")
      : t("settings.osUser.turningOff");
  if (attempt.status === "stopped") return t("settings.osUser.stopped");
  return attempt.message
    ? t("settings.osUser.failedWith", { message: attempt.message })
    : t("settings.osUser.failed");
}
