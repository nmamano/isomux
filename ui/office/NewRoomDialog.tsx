import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoomWire } from "../../shared/types.ts";
import { apiFetch } from "../api.ts";
import { useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "../components/dialog-styles.ts";

export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const opened = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    cancelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!submitting.current) onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement === cancelRef.current)
          confirmRef.current?.focus();
        else cancelRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (!opened.current &&
          (previous instanceof HTMLElement || previous instanceof SVGElement))
        previous.focus();
    };
  }, [onClose]);

  async function openRoom() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      const { room } = await apiFetch<{ room: RoomWire }>(
        "POST",
        "/api/rooms",
        {},
      );
      // The HTTP response can precede the owner's broadcast or the member's
      // projected full_state. Install the room before selecting it.
      opened.current = true;
      dispatch({ type: "room_created", room });
      dispatch({ type: "set_current_room", roomId: room.id });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return createPortal(
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting.current)
          onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-room-title"
        aria-busy={pending}
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: "24px 28px",
          width: 340,
          maxWidth: "calc(100% - 32px)",
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          color: "var(--text-primary)",
        }}
      >
        <h3 id="new-room-title" style={{ margin: 0, fontSize: 17 }}>
          {t("office.newRoom.title")}
        </h3>
        {failed && (
          <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>
            {t("office.newRoom.failed")}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 24,
          }}
        >
          <button
            ref={cancelRef}
            style={dialogCancelBtn}
            disabled={pending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            style={dialogSaveBtn}
            disabled={pending}
            onClick={() => void openRoom()}
          >
            {t("office.newRoom.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
