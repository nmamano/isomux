// The Apps tab - agent-built web apps isomux runs and keeps running. Beside
// Cronjobs, which is the precedent for "a thing isomux runs that is not an
// agent" (internal-docs/agent-apps-design.md).
//
// A VIEWER PLUS VERBS: no register form and no edit form here. Agents register
// apps through the API, with a thumbnail, and this tab is where a human watches
// them and takes them in hand - open, start, stop, restart, archive, read the
// log, delete one.
//
// TWO SOURCES OF TRUTH, DELIBERATELY. The app_upserted / app_deleted deltas
// carry anything isomux itself did, immediately. But systemd changing an app's
// runtime state is not something isomux is told about, so the list is also
// re-fetched every few seconds WHILE THIS TAB IS OPEN, and never when it is
// closed. The fetch
// replaces the slice; the deltas patch it; both converge.

import { useEffect, useRef, useState } from "react";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import {
  getAppFilter,
  getRoomFilter,
  setAppFilter,
  setRoomFilter,
} from "../device-settings.ts";
import {
  appRoomId,
  effectiveRoomFilter,
  roomFilterMatches,
  roomFilterOptions,
} from "../room-filter.ts";
import { RoomFilterSelect } from "./RoomFilterSelect.tsx";
import { MenuItem } from "./ContextMenu.tsx";
import { Portal } from "./Portal.tsx";
import type { AppListWire, AppState, AppWire } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import type {
  MessageKey,
  PlainMessageKey,
  Translator,
} from "../../shared/i18n/translate.ts";

// How often the open tab re-asks for the list. The server caches app state for
// 1500ms behind the supervisor seam, so several open tabs cost at most one
// systemd read per cache window rather than one per tab per tick.
const POLL_MS = 5000;

/**
 * Should a response that has just come back be allowed to write to the shared
 * state it was fetched for? Extracted and exported because this is the whole
 * of the race, and a pure function pins every ordering of it: a request is
 * only allowed to land if nothing has moved on since it was issued.
 *
 * `gen` rules out a superseded request (a second click, a close, an unmount);
 * `target` rules out a response arriving under a DIFFERENT row than the one it
 * was asked for - the case where A's journal would briefly appear under B.
 * A null current target means nothing is open, so nothing may be written.
 */
export function shouldCommit(
  issuedGen: number,
  currentGen: number,
  issuedTarget: string,
  currentTarget: string | null,
): boolean {
  return issuedGen === currentGen && issuedTarget === currentTarget;
}

/**
 * How long to wait before the next poll, or null to stop entirely. Exported for
 * the same reason as shouldCommit: this is the decision that keeps a cancelled
 * polling loop from rescheduling itself. The lifetime it belongs to is a local
 * `let` per effect run, NOT a ref (see the polling effect).
 */
export function nextPollDelay(
  cancelled: boolean,
  landed: boolean,
): number | null {
  if (cancelled) return null;
  return landed ? POLL_MS : 0;
}

// Tailscale's MagicDNS namespace. An office served at a tailnet name answers on
// HTTPS, so the browser upgrades an http link built from that name (cached HSTS
// or auto-upgrade) and it never reaches an app port serving plain http. The
// node's SHORT name carries no https history and resolves on the tailnet, so a
// port link is built from it instead.
//
// The suffix is matched on the LABEL boundary - the same rule as isTailnetName
// in server/app-domain.ts - so `myts.net` and `ts.net.example.com` are ordinary
// domains. The classification is deliberately not identical: that one counts
// the bare apex as tailnet to refuse deriving children, while here the apex
// carries no node label to shorten to, so it is left unchanged.
const TAILNET_SUFFIX = "ts.net";

function portLinkHost(officeHostname: string): string {
  const host = officeHostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(`.${TAILNET_SUFFIX}`)) return officeHostname;
  const node = host.slice(0, host.indexOf("."));
  return node || officeHostname;
}

/**
 * Where the app's name links to. `url` is the office's own answer - the full
 * https origin the app answers on, present exactly when the office has app
 * hostnames at all - so it is used verbatim and nothing about it is derived
 * here. Without one, the link stays what it has always been: this office's
 * host with the app's port, which only reaches the app from inside the box's
 * network - shortened to the node name on a tailnet office, where the long
 * name would be upgraded to https (see portLinkHost). Every other hostname is
 * passed through unchanged.
 *
 * The empty-string check is a boundary fail-safe, not a contract: the wire
 * omits `url` rather than sending "", and an empty href would silently link
 * the row to the page it is already on.
 */
export function appHref(
  app: Pick<AppWire, "url" | "port">,
  officeHostname: string,
): string {
  if (typeof app.url === "string" && app.url !== "") return app.url;
  return `http://${portLinkHost(officeHostname)}:${app.port}/`;
}

export function appLinkHref(
  app: Pick<AppWire, "name" | "url" | "port">,
  officeHostname: string,
  liveAppPreviews: boolean,
): string {
  if (!liveAppPreviews) {
    return `/demo/app?name=${encodeURIComponent(app.name)}`;
  }
  return appHref(app, officeHostname);
}

// Not a component, so the translator arrives as an argument (ruling 18).
export function appLinkLabel(
  t: Translator["t"],
  app: Pick<AppWire, "url">,
): string {
  return typeof app.url === "string" && app.url !== ""
    ? t("apps.openApp")
    : t("apps.openOnNetwork");
}

const STATE_COLOR: Record<AppState, string> = {
  running: "var(--green)",
  starting: "var(--orange, #d29922)",
  stopped: "var(--text-muted)",
  failed: "var(--red)",
  unknown: "var(--text-muted)",
};

// The state word beside the dot, at text strength.
const STATE_TEXT_COLOR: Record<AppState, string> = {
  running: "var(--green-text)",
  starting: "var(--orange-text)",
  stopped: "var(--text-muted)",
  failed: "var(--red-text)",
  unknown: "var(--text-muted)",
};

// A drawn dot, not a glyph: iOS Safari emoji-renders characters like ● and ▶
// and then ignores the CSS color, which would make `failed` and `running` look
// identical on a phone.
function StateDot({ state }: { state: AppState }) {
  const hollow = state === "unknown";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        background: hollow ? "transparent" : STATE_COLOR[state],
        border: hollow ? "1.5px solid var(--text-muted)" : "none",
      }}
    />
  );
}

// Drawn paths stay monochrome on iOS. The text character this replaces can be
// promoted to a colorful emoji even when CSS asks for an ordinary glyph.
function OpenIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M6 3H3.75A1.75 1.75 0 0 0 2 4.75v7.5C2 13.22 2.78 14 3.75 14h7.5A1.75 1.75 0 0 0 13 12.25V10" />
      <path d="M9 2h5v5M14 2 7.5 8.5" />
    </svg>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--text-dim, var(--text-muted))" }}>
        {label}{" "}
      </span>
      <span style={{ color: "var(--text-secondary)" }}>{value}</span>
    </span>
  );
}

/**
 * The live agent behind an app's `created by`, or null when there is nothing to
 * open - a human registered it, or its agent is gone.
 *
 * A record that names an agent id is answered by that id ALONE. A dead id gets
 * nothing rather than the agent that now holds the same nameplate: a successor
 * did not register the app, and the row states who did. The same rule already
 * governs the app-to-agent message route, which answers a gone target with
 * `target_gone` instead of picking another agent (server/routes/handlers/apps.ts).
 *
 * The name match is for records with no id at all - written before the field
 * existed, or registered by a person - where a name is the only attribution
 * there is. That is the rule the task board resolves its own names by.
 */
export function resolveCreatorAgentId(
  app: { createdBy?: string; createdByAgentId?: string },
  agents: readonly { id: string; name: string }[],
): string | null {
  if (app.createdByAgentId !== undefined) {
    const byId = agents.find((a) => a.id === app.createdByAgentId);
    return byId ? byId.id : null;
  }
  const createdBy = app.createdBy;
  if (createdBy === undefined) return null;
  const byName = agents.find(
    (a) => a.name.toLowerCase() === createdBy.toLowerCase(),
  );
  return byName ? byName.id : null;
}

/**
 * Which section of the page an app sits in. A running or starting app is
 * "running". Every other state is "stopped" - a failed or unknown app is a
 * fault the member still has to see - unless a member archived it. An archived
 * app that runs again (systemd brought it back) is shown as running.
 */
export type AppSection = "running" | "stopped" | "archived";

export function appSection(
  app: Pick<AppListWire, "state" | "archived">,
): AppSection {
  if (app.state === "running" || app.state === "starting") return "running";
  return app.archived === true ? "archived" : "stopped";
}

/**
 * The URL of the app's thumbnail, or null when no thumbnail was uploaded. The
 * upload time is in the query so a new upload is a new URL and the browser
 * cache never shows the old image.
 */
export function appThumbnailSrc(
  app: Pick<AppListWire, "name" | "thumbnailUpdatedAt">,
): string | null {
  if (app.thumbnailUpdatedAt === undefined) return null;
  return `/api/apps/${encodeURIComponent(app.name)}/thumbnail?v=${app.thumbnailUpdatedAt}`;
}

/**
 * The verb the thumbnail of a stopped app does, or null when the thumbnail does
 * nothing. A running app's thumbnail opens the app instead. Only a member who
 * can manage the app gets a verb.
 */
export function thumbnailVerb(
  app: Pick<AppListWire, "state" | "canManage">,
): "start" | "restart" | null {
  if (app.canManage !== true) return null;
  if (app.state === "stopped") return "start";
  if (app.state === "failed" || app.state === "unknown") return "restart";
  return null;
}

function PlayIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      style={{ marginLeft: size / 8 }}
    >
      <path d="M5 3.2v9.6a.5.5 0 0 0 .77.42l7.4-4.8a.5.5 0 0 0 0-.84l-7.4-4.8A.5.5 0 0 0 5 3.2z" />
    </svg>
  );
}

// The Archived section's open/closed mark. Drawn, not ▶/▼, for the same iOS
// reason as StateDot.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 0.12s",
      }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function RestartIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v3h-3" />
    </svg>
  );
}

const THUMB_RADIUS = 8;

/**
 * The app's picture, and the main way to act on the app: a running app's
 * thumbnail opens it, a stopped one's starts it. The corner badge says so on
 * every device; a hover adds a clearer label where there is a pointer.
 */
function AppThumbnail({
  app,
  href,
  verb,
  disabled,
  isMobile,
  onVerb,
}: {
  app: AppListWire;
  href: string;
  verb: "start" | "restart" | null;
  disabled: boolean;
  isMobile: boolean;
  onVerb: () => void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  // The version whose image failed to load. A newer upload is a new URL, so it
  // gets its own chance rather than inheriting the old failure.
  const [failedVersion, setFailedVersion] = useState<number | null>(null);
  const version = app.thumbnailUpdatedAt;
  const src = version === failedVersion ? null : appThumbnailSrc(app);
  const running = appSection(app) === "running";
  const width = isMobile ? 112 : 160;
  const frame: React.CSSProperties = {
    position: "relative",
    display: "block",
    flexShrink: 0,
    width,
    aspectRatio: "16 / 10",
    padding: 0,
    // The thumbnail of a running app is a link; its letter fallback is not
    // link text.
    textDecoration: "none",
    borderRadius: THUMB_RADIUS,
    border: `1px solid ${hover && !disabled ? "var(--accent)" : "var(--border-light)"}`,
    background: "var(--bg-code, var(--bg-base))",
    overflow: "hidden",
    cursor: running || (verb && !disabled) ? "pointer" : "default",
    transition: "transform 0.12s, box-shadow 0.12s, border-color 0.12s",
    transform: hover && !disabled ? "translateY(-1px)" : undefined,
    boxShadow:
      hover && !disabled ? "0 6px 18px var(--shadow-heavy)" : undefined,
  };
  const picture = src ? (
    <img
      src={src}
      alt=""
      onError={() => setFailedVersion(version ?? null)}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: "top",
        display: "block",
        filter: running ? undefined : "grayscale(0.8) brightness(0.55)",
      }}
    />
  ) : (
    // No thumbnail yet: the name's first letter, so the row keeps its shape.
    <span
      aria-hidden="true"
      style={{
        display: "grid",
        placeItems: "center",
        width: "100%",
        height: "100%",
        fontSize: isMobile ? 26 : 34,
        fontWeight: 700,
        color: "var(--text-hint)",
        opacity: running ? 1 : 0.6,
        textTransform: "uppercase",
      }}
    >
      {app.name.slice(0, 1)}
    </span>
  );
  const hoverProps = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };

  if (running) {
    const label = appLinkLabel(t, app);
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={label}
        aria-label={`${label}: ${app.name}`}
        data-app-thumbnail="open"
        style={frame}
        {...hoverProps}
      >
        {picture}
        {/* The corner badge is always there; a hover adds the scrim and the
            label on top of it. */}
        {hover && !isMobile && (
          <span
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.45)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 9px",
                borderRadius: 6,
                background: "var(--accent)",
                color: "var(--bg-base)",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {label}
            </span>
          </span>
        )}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 5,
            bottom: 5,
            display: "grid",
            placeItems: "center",
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--bg-overlay)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-light)",
          }}
        >
          <OpenIcon />
        </span>
      </a>
    );
  }

  if (verb) {
    const size = isMobile ? 34 : 40;
    return (
      <button
        type="button"
        title={t(VERB_TITLES[verb])}
        aria-label={`${t(MENU_LABELS[verb])}: ${app.name}`}
        data-app-thumbnail={verb}
        disabled={disabled}
        onClick={onVerb}
        style={frame}
        {...hoverProps}
      >
        {picture}
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
          }}
        >
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: size,
              height: size,
              borderRadius: "50%",
              background:
                hover && !disabled ? "var(--accent)" : "var(--text-primary)",
              color: "var(--bg-base)",
              boxShadow: "0 3px 10px var(--shadow-heavy)",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {verb === "start" ? (
              <PlayIcon size={size * 0.42} />
            ) : (
              <RestartIcon size={size * 0.42} />
            )}
          </span>
        </span>
      </button>
    );
  }

  return <div style={frame}>{picture}</div>;
}

type MenuAction =
  | "start"
  | "stop"
  | "restart"
  | "log"
  | "archive"
  | "unarchive"
  | "delete";

/** The actions a manager's ⋯ menu offers for an app in this state. */
export function appMenuActions(
  app: Pick<AppListWire, "state" | "archived">,
): MenuAction[] {
  const actions: MenuAction[] = [];
  for (const verb of ["start", "stop", "restart"] as const) {
    if (!verbInert(verb, app.state)) actions.push(verb);
  }
  actions.push("log");
  const section = appSection(app);
  if (section === "stopped") actions.push("archive");
  if (section === "archived") actions.push("unarchive");
  actions.push("delete");
  return actions;
}

/**
 * The ⋯ menu, drawn like the agent context menu. It is placed with fixed
 * coordinates under its button, because the app list scrolls and would clip
 * an absolutely placed menu at its bottom edge.
 */
function AppActionsMenu({
  actions,
  disabled,
  onAction,
}: {
  actions: MenuAction[];
  disabled: boolean;
  onAction: (action: MenuAction) => void;
}) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{
    right: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setAt(null);
    };
    const closeOnScroll = () => setAt(null);
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setAt(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [at]);

  function toggle() {
    if (at) {
      setAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = window.innerWidth - rect.right;
    // Open upward when the menu would not fit below the button.
    const below = window.innerHeight - rect.bottom;
    setAt(
      below < 240
        ? { right, bottom: window.innerHeight - rect.top + 4 }
        : { right, top: rect.bottom + 4 },
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={t("common.moreActions")}
        aria-label={t("common.moreActions")}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        data-app-menu-button=""
        onClick={toggle}
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          padding: 0,
          borderRadius: 6,
          border: `1px solid ${at ? "var(--border-light)" : "transparent"}`,
          background: at ? "var(--bg-hover)" : "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
        >
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {at && (
        <Portal>
          <div
            ref={menuRef}
            role="menu"
            data-app-menu=""
            style={{
              position: "fixed",
              right: at.right,
              top: at.top,
              bottom: at.bottom,
              zIndex: 1000,
              background: "var(--bg-overlay)",
              backdropFilter: "blur(16px)",
              border: "1px solid var(--border-light)",
              borderRadius: 12,
              padding: 5,
              minWidth: 170,
              boxShadow: "0 12px 40px var(--shadow-heavy)",
              animation: "hudIn 0.12s ease-out",
            }}
          >
            {actions.map((action) => (
              <div key={action} data-app-menu-action={action}>
                {action === "delete" && (
                  <div
                    style={{
                      height: 1,
                      background: "var(--border-strong)",
                      margin: "3px 8px",
                    }}
                  />
                )}
                <MenuItem
                  label={t(MENU_LABELS[action])}
                  danger={action === "delete"}
                  disabled={disabled && action !== "log"}
                  onClick={() => {
                    setAt(null);
                    onAction(action);
                  }}
                />
              </div>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}

// Section labels share the look of the table headers on the Tasks and
// Schedules pages.
const sectionLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: 0,
  border: "none",
  background: "none",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  fontFamily: "'JetBrains Mono',monospace",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const SECTION_LABELS: Record<AppSection, PlainMessageKey> = {
  running: "apps.section.running",
  stopped: "apps.section.stopped",
  archived: "apps.section.archived",
};

/**
 * The apps the page's filters let through. "Mine" is the owner, the member an
 * app belongs to, not the agent that registered it. With no session there is
 * no "me", so the filter lets everything through.
 */
export function filterApps<T extends Pick<AppListWire, "userId">>(
  apps: readonly T[],
  onlyMine: boolean,
  selfUserId: string | null,
): T[] {
  return apps.filter(
    (app) => !(onlyMine && selfUserId !== null && app.userId !== selfUserId),
  );
}

// A link, not a button-shaped control: the same accent-and-underline affordance
// the task board gives an agent name. A real <button> rather than the task
// board's <span> so it is reachable by keyboard.
const agentLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  color: "var(--accent-text)",
  cursor: "pointer",
  textDecoration: "none",
};

/**
 * An error the page shows: either a message the server sent, which is relayed
 * as delivered (ruling 2), or a catalog key this page chose. A KEY and not
 * finished text, so a language switch re-reads it (the S5 rule). PlainMessageKey,
 * because a union holding one parameterized member would make every t(e.key)
 * demand an argument it has nothing to fill.
 */
type ErrorKey = Extract<MessageKey, `apps.${string}`> & PlainMessageKey;

type PageError =
  | { kind: "relayed"; message: string }
  | { kind: "key"; key: ErrorKey };

function pageError(err: unknown, key: ErrorKey): PageError {
  return err instanceof ApiError
    ? { kind: "relayed", message: err.message }
    : { kind: "key", key };
}

type AppVerb = "start" | "stop" | "restart" | "archive" | "unarchive";

const ACTION_FAILED: Record<AppVerb, ErrorKey> = {
  start: "apps.actionFailed.start",
  stop: "apps.actionFailed.stop",
  restart: "apps.actionFailed.restart",
  archive: "apps.actionFailed.archive",
  unarchive: "apps.actionFailed.unarchive",
};

// Where a deleted app's data directory ends up: the registry moves it under
// `.retired` next to the other apps' data instead of erasing it (Nil's ruling,
// 2026-09-10: no automatic deletion, ever). Shown in the delete confirmation so
// the member knows the data stays on the office's disk and where.
export function retiredDirOf(dataDir: string): string {
  const cut = dataDir.lastIndexOf("/");
  return `${cut > 0 ? dataDir.slice(0, cut) : dataDir}/.retired`;
}

export function AppsView({
  onClose,
  onFocusAgent,
}: {
  onClose: () => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const {
    apps,
    appsLoaded,
    appsRevision,
    isMobile,
    hydrationEpoch,
    agents,
    unavailableFeatures,
    sessionContext,
    rooms,
    allRooms,
  } = useAppState();
  const { t } = useI18n();
  const dispatch = useDispatch();
  const features = useFeatures();
  const [error, setError] = useState<PageError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppWire | null>(null);
  const [onlyMine, setOnlyMine] = useState(() => getAppFilter("onlyMine"));
  const [archivedOpen, setArchivedOpen] = useState(false);
  const selfUserId = sessionContext?.userId ?? null;
  // An app's room is its creator agent's live room, the rule that decides who
  // sees it; an app with no visible creator has no room.
  const roomOptions = roomFilterOptions(rooms, allRooms);
  const [storedRoomFilter, setStoredRoomFilter] = useState(() =>
    getRoomFilter("apps"),
  );
  const roomFilter = effectiveRoomFilter(storedRoomFilter, roomOptions);
  const changeRoomFilter = (value: string) => {
    setStoredRoomFilter(value);
    setRoomFilter("apps", value);
  };
  const [openLogs, setOpenLogs] = useState<AppWire | null>(null);
  // Moves when the USER changes what the log dialog is showing - opening it,
  // closing it, deleting its app - so a request in flight can tell that it no
  // longer speaks for what is on screen.
  //
  // Deliberately NOT touched by any lifecycle event. Coupling it to the polling
  // effect's cleanup meant a rehydrate (which restarts that effect while the tab
  // and its open pane stay mounted) invalidated a pending log request that
  // nothing would then re-issue, stranding the pane on "Loading…" forever. An
  // unmount needs no bump either: the component is gone, so its setState is a
  // no-op, and inventing a lifecycle bump is what created the bug.
  const logGenRef = useRef(0);
  const openLogsRef = useRef<string | null>(null);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logError, setLogError] = useState<PageError | null>(null);
  const errorText = (e: PageError) =>
    e.kind === "relayed" ? e.message : t(e.key);

  // Mirrors the store's app revision so the async poll body reads the CURRENT
  // value rather than the one captured when its closure was created.
  const revisionRef = useRef(appsRevision);

  // revisionRef syncs in an effect rather than during render (writing a ref
  // while rendering is the anti-pattern the lint rule names). Lagging by a
  // commit can only make the poll capture a value that is too LOW, and the
  // reducer then refuses a snapshot it might have accepted. Refusing a good
  // snapshot costs a re-fetch; accepting a stale one is the bug.
  useEffect(() => {
    revisionRef.current = appsRevision;
  }, [appsRevision]);

  // Fetch on mount and on every rehydration, then poll while open.
  //
  // hydrationEpoch, NOT `connected`: ws.ts reconnects a frozen mobile socket
  // without the connected flag ever going false, so an effect keyed on that
  // edge would silently never re-run and this list would sit on whatever it
  // held before the gap.
  //
  // `cancelled` is a LOCAL of each effect run, not a ref, and that is the whole
  // point. A shared ref cannot name a lifecycle: on a rehydrate the outgoing
  // cleanup would clear it and the incoming effect would immediately set it
  // again, so the outgoing loop - still awaiting its fetch - would wake up, see
  // a live flag, and schedule itself alongside the new one. Every rehydrate
  // would leave another poll loop running. A local can only ever be cancelled.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // SINGLE FLIGHT: the next fetch is scheduled when the last one finishes,
    // never on a fixed interval. Against a sick systemd, where a list can take
    // longer than the poll period, an interval would pile up requests that are
    // all obsolete before they land.
    const tick = async () => {
      // The revision AS OF THE REQUEST. Anything the deltas do while this is in
      // flight moves it, and the reducer then refuses this now-older snapshot.
      const revision = revisionRef.current;
      let landed = true;
      try {
        const list = await apiFetch<AppListWire[]>("GET", "/api/apps");
        if (cancelled) return;
        dispatch({ type: "apps_loaded", apps: list, revision });
        setError(null);
        // A snapshot beaten by a delta is refused by the reducer, so come back
        // for a current one instead of leaving the list short for a full tick.
        landed = revision === revisionRef.current;
      } catch (err) {
        if (cancelled) return;
        setError(pageError(err, "apps.loadFailed"));
      }
      const delay = nextPollDelay(cancelled, landed);
      if (delay === null) return;
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [dispatch, hydrationEpoch]);

  // Lifecycle verbs and archive share one shape: POST, and the response is the
  // app's fresh state. The same wire object reaches every other open tab as a
  // delta, so nothing here has to re-fetch.
  async function act(name: string, verb: AppVerb) {
    setBusy(`${name}:${verb}`);
    setError(null);
    try {
      const app = await apiFetch<AppWire>(
        "POST",
        `/api/apps/${encodeURIComponent(name)}/${verb}`,
      );
      // Success is manager-only; its AppWire omits the list flag.
      dispatch({ type: "app_upserted", app: { ...app, canManage: true } });
    } catch (err) {
      setError(pageError(err, ACTION_FAILED[verb]));
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(app: AppWire) {
    setBusy(`${app.name}:delete`);
    setError(null);
    try {
      await apiFetch("DELETE", `/api/apps/${encodeURIComponent(app.name)}`);
      dispatch({ type: "app_deleted", name: app.name });
      setConfirmDelete(null);
      if (openLogsRef.current === app.name) closeLogs();
    } catch (err) {
      setError(pageError(err, "apps.deleteFailed"));
    } finally {
      setBusy(null);
    }
  }

  function closeLogs() {
    logGenRef.current++;
    setOpenLogs(null);
    openLogsRef.current = null;
  }

  async function showLogs(app: AppWire) {
    const gen = ++logGenRef.current;
    const name = app.name;
    setOpenLogs(app);
    openLogsRef.current = name;
    setLogLines(null);
    setLogError(null);
    try {
      const res = await apiFetch<{ name: string; lines: string[] }>(
        "GET",
        `/api/apps/${encodeURIComponent(name)}/logs`,
      );
      if (!shouldCommit(gen, logGenRef.current, name, openLogsRef.current)) {
        return;
      }
      setLogLines(res.lines);
    } catch (err) {
      if (!shouldCommit(gen, logGenRef.current, name, openLogsRef.current)) {
        return;
      }
      setLogError(pageError(err, "apps.logReadFailed"));
    }
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (confirmDelete) {
        e.stopPropagation();
        setConfirmDelete(null);
      } else if (openLogs) {
        e.stopPropagation();
        closeLogs();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [confirmDelete, openLogs]);

  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));
  const shown = filterApps(sorted, onlyMine, selfUserId).filter((app) =>
    roomFilterMatches(roomFilter, appRoomId(app, agents, roomOptions)),
  );
  const bySection: Record<AppSection, AppListWire[]> = {
    running: [],
    stopped: [],
    archived: [],
  };
  for (const app of shown) bySection[appSection(app)].push(app);

  function renderRow(app: AppListWire) {
    const isBusy = busy?.startsWith(`${app.name}:`) ?? false;
    const linkHref = appLinkHref(
      app,
      window.location.hostname,
      features.liveAppPreviews,
    );
    const creatorAgentId = resolveCreatorAgentId(app, agents);
    const creatorName = creatorAgentId
      ? agents.find((agent) => agent.id === creatorAgentId)?.name
      : "createdBy" in app
        ? app.createdBy
        : null;
    const verb = thumbnailVerb(app);
    const stateShown = app.state !== "running" && app.state !== "stopped";
    return (
      <div
        key={app.name}
        data-app-row={app.name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 12 : 14,
          padding: "12px 0",
          borderBottom: "1px solid var(--border-subtle)",
          minWidth: 0,
        }}
      >
        <AppThumbnail
          app={app}
          href={linkHref}
          verb={verb}
          disabled={isBusy}
          isMobile={isMobile}
          onVerb={() => verb && void act(app.name, verb)}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <a
              href={linkHref}
              target="_blank"
              rel="noreferrer"
              title={appLinkLabel(t, app)}
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--accent-text)",
                textDecoration: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {app.name}
            </a>
            {stateShown && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  color: STATE_TEXT_COLOR[app.state],
                  textTransform: "lowercase",
                  whiteSpace: "nowrap",
                }}
              >
                <StateDot state={app.state} />
                {t(STATE_LABELS[app.state])}
              </span>
            )}
          </div>
          {app.description && (
            <div
              title={app.description}
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {app.description}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: "2px 14px",
              flexWrap: "wrap",
              fontSize: 11,
            }}
          >
            {/* The creator opens its conversation when it is still an agent of
                this office; otherwise it stays plain text. */}
            <Meta
              label={t("apps.meta.createdBy")}
              value={
                creatorAgentId !== null ? (
                  <button
                    type="button"
                    title={t("apps.openAgent")}
                    onClick={() => onFocusAgent?.(creatorAgentId)}
                    style={agentLinkStyle}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.textDecoration = "underline")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.textDecoration = "none")
                    }
                  >
                    {creatorName}
                  </button>
                ) : (
                  creatorName
                )
              }
            />
            {app.username && (
              <Meta label={t("apps.meta.owner")} value={app.username} />
            )}
          </div>
          {/* Presence only. startError is in-memory on the server, so its
              absence proves nothing and this never renders an all-clear -
              `state` is the durable signal. */}
          {app.canManage === true && app.startError && (
            <div
              title={app.startError}
              style={{
                fontSize: 11,
                color: "var(--red-text)",
                fontFamily: "var(--font-mono, monospace)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {app.startError}
            </div>
          )}
        </div>
        {app.canManage === true && (
          <AppActionsMenu
            actions={appMenuActions(app)}
            disabled={isBusy}
            onAction={(action) => {
              if (action === "log") void showLogs(app);
              else if (action === "delete") setConfirmDelete(app);
              else void act(app.name, action);
            }}
          />
        )}
      </div>
    );
  }

  function renderSection(section: AppSection) {
    const list = bySection[section];
    if (list.length === 0) return null;
    const collapsible = section === "archived";
    const open = !collapsible || archivedOpen;
    const label = (
      <>
        {t(SECTION_LABELS[section])}
        <span style={{ fontWeight: 400, color: "var(--text-hint)" }}>
          {list.length}
        </span>
        {collapsible && <ChevronIcon open={open} />}
      </>
    );
    return (
      <section key={section} data-app-section={section}>
        <div style={{ padding: "18px 0 2px" }}>
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setArchivedOpen(!open)}
              style={{ ...sectionLabelStyle, cursor: "pointer" }}
            >
              {label}
            </button>
          ) : (
            <h2 style={{ ...sectionLabelStyle, margin: 0 }}>{label}</h2>
          )}
        </div>
        {open && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "minmax(0, 1fr)"
                : "repeat(auto-fill, minmax(420px, 1fr))",
              columnGap: 36,
            }}
          >
            {list.map(renderRow)}
          </div>
        )}
      </section>
    );
  }

  return (
    <div
      data-apps-page=""
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* minHeight (not height) so the safe-area padding extends the bar below
          the notch instead of squashing its contents. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <button
          onClick={onClose}
          aria-label={t("common.back")}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          ←
        </button>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t("common.apps")}</div>
        <div
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {!appsLoaded
            ? ""
            : shown.length < sorted.length
              ? `${shown.length}/${sorted.length}`
              : `${sorted.length}`}
        </div>
      </div>

      {unavailableFeatures.apps !== undefined && (
        <div
          role="note"
          style={{
            padding: "8px 16px",
            background: "var(--bg-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--text-secondary)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {t("apps.unavailable.needsLinux")}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--bg-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--red-text)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {errorText(error)}
        </div>
      )}

      {appsLoaded && sorted.length > 0 && (
        <div
          data-app-filters=""
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 16px",
            padding: isMobile ? "8px 12px" : "8px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            fontSize: 12,
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {selfUserId !== null && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                data-app-filter="onlyMine"
                checked={onlyMine}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setOnlyMine(on);
                  setAppFilter("onlyMine", on);
                }}
                style={{ margin: 0, accentColor: "var(--accent)" }}
              />
              {t("apps.filter.onlyMine")}
            </label>
          )}
          <RoomFilterSelect
            value={roomFilter}
            rooms={roomOptions}
            onChange={changeRoomFilter}
          />
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? "0 12px 12px" : "0 20px 20px",
        }}
      >
        {!appsLoaded ? null : sorted.length === 0 ? (
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              padding: "24px 4px",
            }}
          >
            {t("apps.empty")}
          </div>
        ) : shown.length === 0 ? (
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              padding: "24px 4px",
            }}
          >
            {t("apps.filter.noMatch")}
          </div>
        ) : (
          <div style={{ maxWidth: 1240 }}>
            {(["running", "stopped", "archived"] as const).map(renderSection)}
          </div>
        )}
      </div>

      {openLogs && (
        <div
          onClick={closeLogs}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            role="dialog"
            aria-label={openLogs.name}
            data-app-log=""
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-base)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 18,
              maxWidth: 760,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>{openLogs.name}</div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono, monospace)",
                overflowWrap: "anywhere",
              }}
            >
              {openLogs.command}
              <span style={{ color: "var(--text-hint)" }}>
                {" "}
                {t("apps.commandIn", { cwd: openLogs.cwd })}
              </span>
            </div>
            <pre
              style={{
                margin: 0,
                padding: 10,
                borderRadius: 6,
                background: "var(--bg-code, var(--bg-base))",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-secondary)",
                fontSize: 11,
                height: "min(420px, 60vh)",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {(logError && errorText(logError)) ??
                (logLines === null
                  ? t("common.loading")
                  : logLines.length === 0
                    ? t("apps.logEmpty")
                    : logLines.join("\n"))}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={closeLogs} style={btnStyle(false, false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          onClick={() => setConfirmDelete(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-base)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 18,
              maxWidth: 420,
              width: "100%",
            }}
          >
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              {t("apps.confirmDelete", {
                name: confirmDelete.name,
                path: retiredDirOf(confirmDelete.dataDir),
              })}
            </div>
            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setConfirmDelete(null)}
                style={btnStyle(false, false)}
              >
                {t("apps.cancel")}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => void doDelete(confirmDelete)}
                style={btnStyle(true, busy !== null)}
              >
                {t("apps.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Keys, not words (the S5 id-to-key pattern).
const VERB_TITLES: Record<
  "start" | "stop" | "restart",
  Extract<MessageKey, `apps.verbTitle.${string}`>
> = {
  start: "apps.verbTitle.start",
  stop: "apps.verbTitle.stop",
  restart: "apps.verbTitle.restart",
};

const MENU_LABELS: Record<
  MenuAction,
  Extract<MessageKey, `apps.menu.${string}`> & PlainMessageKey
> = {
  start: "apps.menu.start",
  stop: "apps.menu.stop",
  restart: "apps.menu.restart",
  log: "apps.menu.log",
  archive: "apps.menu.archive",
  unarchive: "apps.menu.unarchive",
  delete: "apps.menu.delete",
};

const STATE_LABELS: Record<
  AppState,
  Extract<MessageKey, `apps.state.${string}`>
> = {
  running: "apps.state.running",
  starting: "apps.state.starting",
  stopped: "apps.state.stopped",
  failed: "apps.state.failed",
  unknown: "apps.state.unknown",
};

// A verb that cannot change the app's current state renders disabled: "start"
// on a running app reads as a bug even though systemd would no-op it. State
// can be up to one poll (5s) stale, so this is an affordance, not a guard -
// "unknown" leaves every verb enabled. "restart" stays enabled on a failed
// app because it is the recovery verb.
function verbInert(
  verb: "start" | "stop" | "restart",
  state: AppState,
): boolean {
  switch (state) {
    case "running":
    case "starting":
      return verb === "start";
    case "stopped":
      return verb !== "start";
    case "failed":
      return verb === "stop";
    case "unknown":
      return false;
  }
}

function btnStyle(danger: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: `1px solid ${danger ? "var(--red)" : "var(--border)"}`,
    background: "transparent",
    color: disabled
      ? "var(--text-hint)"
      : danger
        ? "var(--red-text)"
        : "var(--text-secondary)",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
  };
}
