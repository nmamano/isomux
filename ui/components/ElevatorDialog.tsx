import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { normaliseFloorUrl, type Floor } from "../../shared/floors.ts";
import type { FloorAddReq, FloorAddRes } from "../../shared/contract-shapes.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { secondaryBorder, secondaryFill } from "./dialog-styles.ts";

// The lobby elevator: the floors (other offices this office links to), a way
// to open one, remove one, and add another office by its address. The server
// checks the address and takes the office name from it (POST /api/floors).
// The list itself comes from the store, which floors_updated keeps live.

// `ownOrigin` and `openFloor` default to this page's origin and a same-tab
// navigation; tests pass their own.
export interface ElevatorDialogProps {
  onClose: () => void;
  ownOrigin?: string;
  openFloor?: (url: string) => void;
}

const ERROR_KEYS: Record<string, PlainMessageKey> = {
  office_unreachable: "lobby.elevator.error.unreachable",
  floor_exists: "lobby.elevator.error.exists",
  too_many_floors: "lobby.elevator.error.full",
  invalid_request: "lobby.elevator.error.invalid",
};

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
  const { floors, isMobile } = useAppState();
  const [address, setAddress] = useState("");
  const [errorKey, setErrorKey] = useState<PlainMessageKey | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // A click while the server checks an address sends nothing.
  const addingRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

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

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
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
          marginTop: isMobile ? "env(safe-area-inset-top, 16px)" : undefined,
          marginBottom: isMobile ? 16 : undefined,
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
          {floors.length === 0 && (
            <p
              style={{
                fontSize: 12,
                color: "var(--text-ghost)",
                margin: 0,
              }}
            >
              {t("lobby.elevator.empty")}
            </p>
          )}
          {floors.map((floor, i) => {
            const host = hostOf(floor.url);
            const name = floor.name ?? host;
            return (
              <div
                key={floor.id}
                data-floor-id={floor.id}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <button
                  type="button"
                  data-floor-action="open"
                  onClick={() => openFloor(floor.url)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--bg-input)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "none",
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      border: "1px solid var(--border-light)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--accent-text)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ minWidth: 0 }}>
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
                      {name}
                    </span>
                    {floor.name !== null && (
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
                </button>
                <button
                  type="button"
                  data-floor-action="remove"
                  aria-label={t("lobby.elevator.remove", { name })}
                  title={t("lobby.elevator.remove", { name })}
                  onClick={() => void remove(floor)}
                  style={{
                    flex: "none",
                    width: 30,
                    height: 30,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    borderRadius: 8,
                    border: secondaryBorder,
                    background: secondaryFill,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path
                      d="M2 2l8 8M10 2l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            );
          })}
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
