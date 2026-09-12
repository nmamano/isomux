import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoomWire } from "../../shared/types.ts";
import { apiFetch } from "../api.ts";
import { useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import {
  dialogCancelBtn,
  dialogInput,
  dialogSaveBtn,
} from "../components/dialog-styles.ts";
import {
  DEFAULT_ROOM_SKIN,
  ROOM_SKIN_IDS,
  type RoomSkin,
} from "../../shared/room-skins.ts";
import type { RoomCreateReq } from "../../shared/contract-shapes.ts";

export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const opened = useRef(false);
  const [skin, setSkin] = useState<RoomSkin>(DEFAULT_ROOM_SKIN);
  const skinRef = useRef<HTMLSelectElement>(null);
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
        // The dialog traps Tab by hand, so every control it grows has to be
        // listed here or the keyboard cannot reach it. In DOM order, which is
        // the order a reader expects Tab to take.
        const focusOrder = [skinRef, cancelRef, confirmRef];
        const current = focusOrder.findIndex(
          (ref) => ref.current === document.activeElement,
        );
        // Focus outside the ring (or nowhere) re-enters at Cancel, which is
        // also where the dialog opens.
        if (current < 0) {
          cancelRef.current?.focus();
          return;
        }
        const step = event.shiftKey ? -1 : 1;
        const next = (current + step + focusOrder.length) % focusOrder.length;
        focusOrder[next].current?.focus();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (
        !opened.current &&
        (previous instanceof HTMLElement || previous instanceof SVGElement)
      )
        previous.focus();
    };
  }, [onClose]);

  async function openRoom() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      // The default look is the absence of the field, so a room opened without
      // touching the control carries no skin at all - the same record every
      // room had before skins existed.
      const body: RoomCreateReq = skin === DEFAULT_ROOM_SKIN ? {} : { skin };
      const { room } = await apiFetch<{ room: RoomWire }>(
        "POST",
        "/api/rooms",
        body,
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
        <label
          htmlFor="new-room-skin"
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 18,
            marginBottom: 5,
          }}
        >
          {t("office.skin.label")}
        </label>
        <select
          ref={skinRef}
          id="new-room-skin"
          value={skin}
          disabled={pending}
          onChange={(e) => setSkin(e.target.value as RoomSkin)}
          style={dialogInput}
        >
          {ROOM_SKIN_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`office.skin.${id}`)}
            </option>
          ))}
        </select>
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
