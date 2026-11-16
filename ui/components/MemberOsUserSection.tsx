import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch } from "../api.ts";
import type {
  MemberOsUserWire,
  MemberTokenViewRes,
  MemberUserUnsupported,
} from "../../shared/contract-shapes.ts";
import { CopyButton } from "./CopyButton.tsx";
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
  const route = `/api/users/${encodeURIComponent(username)}/os-user`;

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
  const commands: { hint: string; line: string }[] =
    view.commands === null
      ? []
      : view.state === "off"
        ? [
            {
              hint: t("settings.osUser.enableHint"),
              line: view.commands.enable,
            },
          ]
        : view.state === "not_ready"
          ? [
              {
                hint: view.unfinished
                  ? t("settings.osUser.finishHint")
                  : t("settings.osUser.rerunHint"),
                line: view.commands.enable,
              },
              {
                hint: t("settings.osUser.disableHint"),
                line: view.commands.disable,
              },
            ]
          : [
              {
                hint: t("settings.osUser.disableHint"),
                line: view.commands.disable,
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
      {commands.map(({ hint, line: command }) => (
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
        </div>
      ))}
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
