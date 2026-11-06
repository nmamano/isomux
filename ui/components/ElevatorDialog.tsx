import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { normaliseFloorUrl, type Floor } from "../../shared/floors.ts";
import type {
  FloorAddReq,
  FloorAddRes,
  FloorNameRes,
} from "../../shared/contract-shapes.ts";
import {
  panelButtons,
  removeFromPanel,
  type Panel,
  type PanelButton,
} from "../../shared/elevator-panel.ts";
import {
  PANEL_NAME_TTL_MS,
  commitPanel,
  readNames,
  readPanel,
  rememberName,
  rideFragment,
  type PanelName,
} from "../elevator-panel-store.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import {
  armedConfirmLook,
  secondaryBorder,
  secondaryFill,
} from "./dialog-styles.ts";
import { isConfirmArmed, useConfirmStep } from "../hooks/useConfirmStep.ts";
import { isTouchPrimary } from "../touch-primary.ts";
import { useVisibleArea } from "../visible-area.ts";

// The lobby elevator: one button per office on this browser's panel
// (shared/elevator-panel.ts) - the offices it rode through, their floors and
// this office's own floors (the store, which floors_updated keeps live) - a
// way to open one, remove one, and add another office by its address. The
// server checks the address and takes the office name from it
// (POST /api/floors). A ride carries the panel to the next office.

// `ownOrigin` and `openFloor` default to this page's origin and a same-tab
// navigation; tests pass their own.
export interface ElevatorDialogProps {
  onClose: () => void;
  ownOrigin?: string;
  openFloor?: (url: string) => void;
}

const ERROR_KEYS: Record<string, PlainMessageKey> = {
  office_unreachable: "lobby.elevator.error.unreachable",
  office_outdated: "lobby.elevator.error.outdated",
  floor_exists: "lobby.elevator.error.exists",
  too_many_floors: "lobby.elevator.error.full",
  invalid_request: "lobby.elevator.error.invalid",
};

// Name lookups one open dialog has in flight; the server refuses more.
const MAX_NAME_ASKS = 4;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ElevatorDialog({
  onClose,
  ownOrigin = location.origin,
  openFloor = (url) => location.assign(url),
}: ElevatorDialogProps) {
  const { t } = useI18n();
  const { floors, isMobile, office } = useAppState();
  const here = normaliseFloorUrl(ownOrigin) ?? ownOrigin;
  const [panel, setPanel] = useState<Panel>(() => readPanel());
  const [names, setNames] = useState<Record<string, PanelName>>(() =>
    readNames(),
  );
  const buttons = panelButtons(panel, here, floors);
  const [address, setAddress] = useState("");
  const [errorKey, setErrorKey] = useState<PlainMessageKey | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // A click while the server checks an address sends nothing.
  const addingRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  // On a touch screen the focus would open the keyboard; most rides go to
  // an office already on the panel.
  useEffect(() => {
    if (!isTouchPrimary()) fieldRef.current?.focus();
  }, []);
  // On a phone the overlay covers only the visible area, so the dialog
  // centers above the keyboard and again once it closes.
  const visible = useVisibleArea(isMobile);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Escape on an armed remove ends that confirm, not the dialog.
      if (e.key === "Escape" && !isConfirmArmed()) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  // Each personal entry without a fresh name: ask this office's server, at
  // most MAX_NAME_ASKS at a time. A failed lookup is kept as no name until it
  // is stale; a busy one is asked again at the next open.
  const personal = buttons
    .filter((b) => b.kind === "visited" || b.kind === "snapshot")
    .map((b) => b.url);
  const personalKey = personal.join(" ");
  useEffect(() => {
    let cancelled = false;
    const kept = readNames();
    const now = Date.now();
    const queue = personal.filter(
      (url) => !kept[url] || now - kept[url].at >= PANEL_NAME_TTL_MS,
    );
    const keep = buttons.map((b) => b.url);
    const next = async (): Promise<void> => {
      const url = queue.shift();
      if (url === undefined || cancelled) return;
      try {
        const res = await apiFetch<FloorNameRes>(
          "GET",
          `/api/floors/name?url=${encodeURIComponent(url)}`,
        );
        rememberName(url, res.name, keep);
      } catch (e) {
        if (e instanceof ApiError && e.code === "office_unreachable")
          rememberName(url, null, keep);
      }
      if (!cancelled) setNames(readNames());
      return next();
    };
    for (let i = 0; i < MAX_NAME_ASKS; i++) void next();
    return () => {
      cancelled = true;
    };
    // The list of personal entries is the only input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalKey]);

  function ride(url: string) {
    openFloor(`${url}/#${rideFragment(here, floors)}`);
  }

  function removePersonal(url: string) {
    showError(null);
    setPanel(commitPanel((p) => removeFromPanel(p, url, Date.now())));
  }

  function showError(key: PlainMessageKey | null, text: string | null = null) {
    setErrorKey(key);
    setErrorText(text);
  }

  async function add() {
    if (addingRef.current) return;
    const url = normaliseFloorUrl(address);
    if (!url) return showError("lobby.elevator.error.invalid");
    if (url === normaliseFloorUrl(ownOrigin))
      return showError("lobby.elevator.error.self");
    showError(null);
    addingRef.current = true;
    setAdding(true);
    try {
      const body: FloorAddReq = { url };
      await apiFetch<FloorAddRes>("POST", "/api/floors", body);
      setAddress("");
    } catch (e) {
      const key = e instanceof ApiError ? ERROR_KEYS[e.code] : undefined;
      if (key) showError(key);
      else
        showError(
          null,
          e instanceof ApiError ? e.message : t("common.saveFailed"),
        );
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  }

  async function remove(floor: Floor) {
    showError(null);
    try {
      await apiFetch<void>("DELETE", `/api/floors/${floor.id}`);
    } catch (e) {
      // Already gone (another member, or a second click): floors_updated
      // drops the row.
      if (e instanceof ApiError && e.code === "floor_not_found") return;
      showError(
        null,
        e instanceof ApiError ? e.message : t("common.saveFailed"),
      );
    }
  }

  const shownError = errorKey ? t(errorKey) : errorText;

  // The name to show, or null for the host alone. Never a name a ride
  // carried: this office's own name, a floor's name from floors.json, or the
  // name this office's server read from the office's card.
  function nameOf(button: PanelButton): string | null {
    if (button.kind === "here") return office.name?.trim() || null;
    if (button.floor) return button.floor.name;
    return names[button.url]?.name ?? null;
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        ...(visible
          ? {
              top: visible.top,
              bottom: window.innerHeight - visible.top - visible.height,
              left: 0,
              right: 0,
            }
          : { inset: 0 }),
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "max(16px, env(safe-area-inset-top, 0px))",
        paddingBottom: "max(16px, env(safe-area-inset-bottom, 0px))",
        boxSizing: "border-box",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="elevator-title"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: "24px 28px",
          // Centered when it fits; at the top, scrolling, when it is taller,
          // where alignItems center would cut off its top.
          margin: "auto",
          width: isMobile ? "calc(100% - 32px)" : 440,
          maxWidth: isMobile ? "100%" : undefined,
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <h3
          id="elevator-title"
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: 0,
            color: "var(--text-primary)",
          }}
        >
          {t("lobby.elevator.title")}
        </h3>
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            margin: "6px 0 0",
          }}
        >
          {t("lobby.elevator.hint")}
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 16,
          }}
        >
          {buttons.map((button, i) => (
            <PanelRow
              key={button.url}
              button={button}
              index={i}
              name={nameOf(button)}
              onOpen={() => ride(button.url)}
              onRemove={() =>
                button.floor
                  ? void remove(button.floor)
                  : removePersonal(button.url)
              }
            />
          ))}
        </div>

        <label
          htmlFor="elevator-address"
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 18,
            marginBottom: 5,
          }}
        >
          {t("lobby.elevator.addLabel")}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="elevator-address"
            ref={fieldRef}
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="office.example.com"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "8px 12px",
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              outline: "none",
            }}
          />
          <button
            type="button"
            data-floor-action="add"
            onClick={() => void add()}
            disabled={adding || !address.trim()}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent-text)",
              color: "var(--bg-base)",
              fontSize: 12,
              fontWeight: 600,
              cursor: adding || !address.trim() ? "default" : "pointer",
              opacity: adding || !address.trim() ? 0.5 : 1,
            }}
          >
            {adding ? t("lobby.elevator.adding") : t("lobby.elevator.add")}
          </button>
        </div>

        {shownError && (
          <p
            role="alert"
            style={{
              fontSize: 11,
              color: "var(--red-text)",
              margin: "10px 0 0",
            }}
          >
            {shownError}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: secondaryBorder,
              background: secondaryFill,
              color: "var(--text-dim)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PanelRowProps {
  button: PanelButton;
  index: number;
  name: string | null;
  onOpen: () => void;
  onRemove: () => void;
}

// One panel button: a ride to that office and a remove, or, for this office,
// a lit button that goes nowhere.
function PanelRow({ button, index, name, onOpen, onRemove }: PanelRowProps) {
  const { t } = useI18n();
  const host = hostOf(button.url);
  const label = name ?? host;
  const isHere = button.kind === "here";
  // An office floor goes for every member; a personal entry only from this
  // member's panel.
  const removeLabel = button.floor
    ? t("lobby.elevator.remove", { name: label })
    : t("lobby.elevator.removeMine", { name: label });
  // A removed button has no Undo: remove asks first.
  const removeStep = useConfirmStep();
  const armed = removeStep.armed !== null;
  const face = (
    <>
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          width: 24,
          height: 24,
          borderRadius: 12,
          border: isHere
            ? "1px solid var(--accent-text)"
            : "1px solid var(--border-light)",
          background: isHere ? "var(--accent-text)" : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          color: isHere ? "var(--bg-base)" : "var(--accent-text)",
        }}
      >
        {index + 1}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          {...noTranslate()}
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {name !== null && (
          <span
            {...noTranslate()}
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {host}
          </span>
        )}
      </span>
      {isHere && (
        <span
          style={{
            flex: "none",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--accent-text)",
          }}
        >
          {t("lobby.elevator.here")}
        </span>
      )}
    </>
  );
  const faceStyle = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 10,
    color: "var(--text-primary)",
    textAlign: "left",
  } as const;
  return (
    <div
      data-panel-url={button.url}
      data-panel-kind={button.kind}
      data-floor-id={button.floor?.id}
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      {isHere ? (
        <div
          aria-current="location"
          style={{
            ...faceStyle,
            border: "1px solid var(--accent-text)",
            background: "var(--bg-input)",
          }}
        >
          {face}
        </div>
      ) : (
        <>
          <button
            type="button"
            data-floor-action="open"
            onClick={onOpen}
            style={{
              ...faceStyle,
              border: "1px solid var(--border)",
              background: "var(--bg-input)",
              cursor: "pointer",
            }}
          >
            {face}
          </button>
          <button
            type="button"
            data-floor-action="remove"
            {...removeStep.bind("remove")}
            aria-label={armed ? t("common.confirmQuestion") : removeLabel}
            title={removeLabel}
            onClick={() => removeStep.confirm("remove", onRemove)}
            style={{
              flex: "none",
              // Armed, it widens to the left: the row's right edge, and the
              // pointer on the button, stay where they were.
              minWidth: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: armed ? "0 10px" : 0,
              borderRadius: 8,
              border: secondaryBorder,
              background: secondaryFill,
              color: "var(--text-dim)",
              cursor: "pointer",
              ...(armed
                ? {
                    ...armedConfirmLook,
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }
                : {}),
            }}
          >
            {armed ? (
              t("common.confirmQuestion")
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path
                  d="M2 2l8 8M10 2l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </>
      )}
    </div>
  );
}
