import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, apiFetch } from "../api.ts";
import {
  OS_USER_NAME_PATTERN,
  type MemberOsUserRunReq,
  type MemberOsUserWire,
  type MemberTokenViewRes,
  type MemberUserUnsupported,
} from "../../shared/contract-shapes.ts";
import { CopyButton } from "./CopyButton.tsx";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";

// Settings > Members > a member > OS user (server/member-os-user-view.ts,
// internal-docs/member-os-user-design.md 2.1): an office owner turns their
// own OS user on or off with one root command, shown here to copy. Where the
// command cannot run, the OS user shows in a disabled field with the reason;
// nothing renders when the read fails or the answer has no support field.
//
// While off, a server that sends newUserName (task e15a82e7) gets a picker:
// the office's user (no command), an existing user from its list or typed by
// name, or a new user. The enable command and Run carry the pick.
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
  // The owner's pick while off: "office", "existing:<name>", "new" or
  // "other"; and the names typed for a new and for another existing user
  // (null: the new user's default name).
  const [pick, setPick] = useState("office");
  const [newName, setNewName] = useState<string | null>(null);
  const [otherName, setOtherName] = useState("");
  const route = `/api/users/${encodeURIComponent(username)}/os-user`;

  // Run (4c-iii): the server runs the command as root with the password;
  // the end shows through the GET's attempt.
  const runCommand = async (
    action: "enable" | "disable",
    password: string | null,
    target: OsUserTarget | null,
  ): Promise<boolean> => {
    setRunError(null);
    const body: MemberOsUserRunReq = {
      action,
      ...(password === null ? {} : { password }),
      ...(target
        ? {
            osUser: target.osUser,
            ...(target.existing ? { existing: true } : {}),
          }
        : {}),
    };
    try {
      await apiFetch("POST", `${route}/run`, body);
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
  if (!view.support.ok) {
    // Their own OS user, or the office's while off. A broken record names
    // no user, so nothing shows. No hint: it describes a change this office cannot make.
    const name =
      view.osUser?.name ??
      (view.state === "off" ? view.officeOsUser : undefined);
    return (
      <div data-testid="member-os-user">
        <h5 style={headingStyle}>{t("settings.osUser.title")}</h5>
        {name && (
          <input
            data-testid="member-os-user-name"
            type="text"
            readOnly
            disabled
            value={name}
            aria-label={t("settings.osUser.title")}
            style={{
              ...dialogInput,
              display: "block",
              maxWidth: 340,
              marginTop: 8,
              opacity: 0.6,
              cursor: "not-allowed",
            }}
          />
        )}
        <p
          data-testid="member-os-user-unsupported"
          data-reason={view.support.reason}
          style={{
            fontSize: 12,
            margin: "6px 0",
            color: "var(--text-muted)",
          }}
        >
          {t(UNSUPPORTED_KEY[view.support.reason])}
        </p>
      </div>
    );
  }

  // Off: turn it on. Not ready: an enable that the office's restart cut
  // finishes when it runs again, so both. Came with an office move: the
  // enable places her files; the disable deletes them. Otherwise: turn it
  // off.
  const picking =
    view.state === "off" &&
    view.commands !== null &&
    view.newUserName !== undefined;
  const newUserName = newName ?? view.newUserName ?? "";
  const target = picking
    ? pickTarget(pick, { newName: newUserName, otherName })
    : null;
  const commands: {
    hint: string;
    line: string;
    action: "enable" | "disable";
    noRun?: boolean;
    target?: OsUserTarget;
  }[] =
    view.commands === null
      ? []
      : picking
        ? target
          ? [
              {
                hint: t("settings.osUser.enableHint"),
                line: `${view.commands.enable} ${target.existing ? "--existing-user" : "--user"} ${target.osUser}`,
                action: "enable",
                target,
              },
            ]
          : []
        : view.state === "off"
          ? [
              {
                hint: t("settings.osUser.enableHint"),
                line: view.commands.enable,
                action: "enable",
              },
            ]
          : view.state === "not_ready" && view.movedIn
            ? [
                {
                  hint: t("settings.osUser.movedInEnableHint"),
                  line: view.commands.enable,
                  action: "enable",
                },
                {
                  hint: t("settings.osUser.movedInDisableHint"),
                  line: view.commands.disable,
                  action: "disable",
                  // Run sends a plain disable, which the office refuses for
                  // a member who came with a move: copy only.
                  noRun: true,
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
        data-moved-in={view.movedIn ? "true" : undefined}
        data-adopted={view.adopted ? "true" : undefined}
        style={{ fontSize: 13, margin: "6px 0", color: "var(--text-primary)" }}
      >
        {stateLine(view, t)}
      </p>
      {view.adopted && view.state !== "off" && (
        <p style={hintStyle}>{t("settings.osUser.adopted")}</p>
      )}
      {view.rootCapable && view.state !== "off" && (
        <p
          data-testid="member-os-user-root-capable"
          role="note"
          style={{ fontSize: 12, margin: "4px 0", color: "var(--red-text)" }}
        >
          {t("settings.osUser.rootCapable", { name: view.osUser?.name ?? "" })}
        </p>
      )}
      {picking && (
        <div style={{ marginTop: 8 }}>
          <label style={hintStyle}>
            {t("settings.osUser.pick")}
            <select
              data-testid="member-os-user-pick"
              value={pick}
              onChange={(event) => setPick(event.target.value)}
              style={{
                ...dialogInput,
                display: "block",
                maxWidth: 340,
                marginTop: 4,
              }}
            >
              <option value="office">
                {view.officeOsUser
                  ? t("settings.osUser.pickOffice", {
                      name: view.officeOsUser,
                    })
                  : t("settings.osUser.pickOfficeUnnamed")}
              </option>
              {view.candidates?.map((candidate) => (
                <option
                  key={candidate.name}
                  value={`${EXISTING}${candidate.name}`}
                >
                  {candidate.name}
                </option>
              ))}
              <option value="new">{t("settings.osUser.pickNew")}</option>
              {view.candidates && (
                <option value="other">{t("settings.osUser.pickOther")}</option>
              )}
            </select>
          </label>
          {pick === "new" && (
            <input
              data-testid="member-os-user-new-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("settings.osUser.newName")}
              placeholder={t("settings.osUser.newName")}
              value={newUserName}
              onChange={(event) => setNewName(event.target.value)}
              style={{
                ...dialogInput,
                display: "block",
                maxWidth: 340,
                marginTop: 6,
              }}
            />
          )}
          {pick === "other" && (
            <input
              data-testid="member-os-user-existing-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("settings.osUser.existingName")}
              placeholder={t("settings.osUser.existingName")}
              value={otherName}
              onChange={(event) => setOtherName(event.target.value)}
              style={{
                ...dialogInput,
                display: "block",
                maxWidth: 340,
                marginTop: 6,
              }}
            />
          )}
        </div>
      )}
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
      {commands.map(({ hint, line: command, action, noRun, target }) => (
        <div key={action}>
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
          {view.run && !noRun && (
            <RunControl
              withPassword={view.run === "password"}
              blocked={running}
              onRun={(password) => runCommand(action, password, target ?? null)}
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

// The OS user that Run and the command name for the pick.
interface OsUserTarget {
  osUser: string;
  existing: boolean;
}

const EXISTING = "existing:";

// The pick's target, or null: the office's user, or a name that the root
// command does not take.
function pickTarget(
  pick: string,
  names: { newName: string; otherName: string },
): OsUserTarget | null {
  const named = (osUser: string, existing: boolean) =>
    OS_USER_NAME_PATTERN.test(osUser) ? { osUser, existing } : null;
  if (pick.startsWith(EXISTING))
    return named(pick.slice(EXISTING.length), true);
  if (pick === "new") return named(names.newName, false);
  if (pick === "other") return named(names.otherName, true);
  return null;
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
      return view.officeOsUser
        ? t("settings.osUser.offAs", { name: view.officeOsUser })
        : t("settings.osUser.off");
    case "on":
      return t("settings.osUser.on", { name });
    case "moving":
      return t("settings.osUser.moving", { name });
    case "not_ready":
      if (view.movedIn) return t("settings.osUser.movedIn");
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
