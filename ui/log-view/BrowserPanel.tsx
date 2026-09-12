import { useCallback, useEffect, useRef, useState } from "react";
import { addRawListener, removeRawListener, send } from "../ws.ts";
import { useI18n } from "../i18n.tsx";
import {
  BROWSER_MIN_DIM,
  BROWSER_MAX_DIM,
  type BrowserHumanInput,
  type BrowserNavigation,
  type ServerMessage,
} from "../../shared/types.ts";

type Frame = { data: string; width: number; height: number };

/** Mounted only for the chat being viewed; background chats cannot open a panel. */
export function useBrowserAutoOpen(
  agentId: string,
  canDrive: boolean,
  open: () => void,
) {
  useEffect(() => {
    if (!canDrive) return;
    const listener = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "browser_action" && message.agentId === agentId)
        open();
    };
    addRawListener(listener);
    return () => removeRawListener(listener);
  }, [agentId, canDrive, open]);
}

export function BrowserPanel({
  agentId,
  canDrive = false,
  onClose,
}: {
  agentId: string;
  canDrive?: boolean;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = useRef(false);
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const captureBounds = useRef<{ maxWidth?: number; maxHeight?: number }>({});
  const motion = useRef<BrowserHumanInput | null>(null);
  const motionTick = useRef<number | null>(null);

  const input = useCallback(
    (value: BrowserHumanInput) => {
      if (canDrive) send({ type: "browser_input", agentId, input: value });
    },
    [agentId, canDrive],
  );

  const navigate = useCallback(
    (action: BrowserNavigation["action"], nextUrl?: string) => {
      if (!canDrive) return;
      setBusy(true);
      setError("");
      input({
        kind: "navigate",
        action,
        ...(nextUrl === undefined ? {} : { url: nextUrl }),
      });
    },
    [canDrive, input],
  );

  useEffect(() => {
    let alive = true;
    let pending: Frame | null = null;
    let decoding = false;
    let generation = 0;
    // One image decode and one replaceable pending frame. A slow viewer cannot
    // accumulate old images behind the current page.
    const decode = () => {
      if (!alive || decoding || !pending) return;
      const frame = pending;
      pending = null;
      decoding = true;
      const epoch = generation;
      const image = new Image();
      const finish = () => {
        decoding = false;
        decode();
      };
      image.onload = () => {
        if (alive && epoch === generation && surfaceRef.current) {
          const canvas = surfaceRef.current;
          const width = image.naturalWidth || frame.width;
          const height = image.naturalHeight || frame.height;
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
          setSize((old) =>
            old?.width === frame.width && old.height === frame.height
              ? old
              : { width: frame.width, height: frame.height },
          );
        }
        finish();
      };
      image.onerror = finish;
      image.src = `data:image/jpeg;base64,${frame.data}`;
    };
    const subscribe = () =>
      send({
        type: "browser_watch",
        agentId,
        watching: true,
        ...captureBounds.current,
      });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (!rect || rect.width <= 0 || rect.height <= 0) return;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              const bound = (value: number) =>
                Math.max(
                  BROWSER_MIN_DIM,
                  Math.min(
                    BROWSER_MAX_DIM,
                    Math.ceil((value * window.devicePixelRatio) / 16) * 16,
                  ),
                );
              const next = {
                maxWidth: bound(rect.width),
                maxHeight: bound(rect.height),
              };
              if (
                next.maxWidth === captureBounds.current.maxWidth &&
                next.maxHeight === captureBounds.current.maxHeight
              )
                return;
              captureBounds.current = next;
              subscribe();
            }, 150);
          });
    if (viewportRef.current) observer?.observe(viewportRef.current);
    const listener = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "full_state") {
        subscribe();
        return;
      }
      if (!("agentId" in message) || message.agentId !== agentId) return;
      if (message.type === "browser_frame") {
        setSize((old) =>
          old?.width === message.width && old.height === message.height
            ? old
            : { width: message.width, height: message.height },
        );
        pending = message;
        decode();
      } else if (message.type === "browser_status") {
        setAvailable(message.available);
        if (message.url !== undefined && !editing.current)
          setUrl(message.url === "about:blank" ? "" : message.url);
        if (message.title !== undefined) setTitle(message.title);
        if (message.busy !== undefined) setBusy(message.busy);
        setError(message.error ?? "");
        if (!message.available) {
          pending = null;
          generation++;
          setSize(null);
        }
      }
    };
    addRawListener(listener);
    subscribe();
    if (canDrive) navigate("open");
    return () => {
      alive = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      pending = null;
      send({ type: "browser_watch", agentId, watching: false });
      removeRawListener(listener);
    };
  }, [agentId, canDrive, navigate]);

  const flushMotion = useCallback(() => {
    if (motionTick.current !== null) cancelAnimationFrame(motionTick.current);
    motionTick.current = null;
    if (motion.current) input(motion.current);
    motion.current = null;
  }, [input]);
  useEffect(
    () => () => {
      if (motionTick.current !== null) cancelAnimationFrame(motionTick.current);
      motionTick.current = null;
      motion.current = null;
    },
    [agentId, canDrive],
  );

  const point = (
    event: React.MouseEvent<HTMLCanvasElement>,
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
  ) => {
    if (!canDrive || !size) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const value: BrowserHumanInput = {
      kind: "mouse",
      event: type,
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    };
    if (type === "mouseMoved") {
      motion.current = value;
      if (motionTick.current === null)
        motionTick.current = requestAnimationFrame(flushMotion);
    } else {
      flushMotion();
      input(value);
    }
  };
  const buttonStyle = {
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "var(--bg-subtle)",
    color: "var(--text-primary)",
    padding: "4px 8px",
    cursor: "pointer",
  };
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        borderLeft: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          minHeight: 42,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong style={{ flex: 1 }}>{i18n.t("panels.browser.title")}</strong>
        {canDrive && (
          <button
            style={buttonStyle}
            disabled={!available || busy}
            onClick={() => navigate("close")}
          >
            {i18n.t("panels.browser.endPage")}
          </button>
        )}
        <button
          style={buttonStyle}
          onClick={onClose}
          aria-label={i18n.t("panels.browser.close")}
          title={i18n.t("panels.browser.close")}
        >
          ×
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          editing.current = false;
          navigate(
            "goto",
            /^[a-z][a-z0-9+.-]*:/i.test(url.trim())
              ? url.trim()
              : `https://${url.trim()}`,
          );
        }}
        style={{
          display: "flex",
          gap: 4,
          padding: 8,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {(["back", "forward", "reload"] as const).map((action) => (
          <button
            key={action}
            type="button"
            style={buttonStyle}
            disabled={!canDrive || !available || busy}
            onClick={() => navigate(action)}
            title={i18n.t(`panels.browser.${action}`)}
            aria-label={i18n.t(`panels.browser.${action}`)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path
                d={
                  action === "back"
                    ? "M15 5l-7 7 7 7"
                    : action === "forward"
                      ? "M9 5l7 7-7 7"
                      : "M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-2-2"
                }
              />
            </svg>
          </button>
        ))}
        <input
          value={url}
          readOnly={!canDrive}
          aria-label={i18n.t("panels.browser.address")}
          placeholder={i18n.t("panels.browser.address")}
          onFocus={() => (editing.current = true)}
          onBlur={() => (editing.current = false)}
          onChange={(event) => setUrl(event.target.value)}
          style={{
            minWidth: 0,
            flex: 1,
            background: "var(--bg-code)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "4px 8px",
          }}
        />
        {canDrive && (
          <button style={buttonStyle} disabled={busy || !url.trim()}>
            {i18n.t("panels.browser.go")}
          </button>
        )}
      </form>
      <div
        aria-live="polite"
        style={{
          padding: "4px 10px",
          color: error ? "var(--text-primary)" : "var(--text-dim)",
          fontSize: 12,
        }}
      >
        {error ||
          (busy
            ? i18n.t("panels.browser.loading")
            : !canDrive
              ? i18n.t("panels.browser.readOnly")
              : title)}
      </div>
      <div
        ref={viewportRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          padding: 10,
          background: "var(--bg-code)",
          overflow: "hidden",
        }}
      >
        <canvas
          ref={surfaceRef}
          role="application"
          aria-label={i18n.t("panels.browser.surface")}
          tabIndex={canDrive ? 0 : -1}
          onMouseMove={(event) => point(event, "mouseMoved")}
          onMouseDown={(event) => {
            if (canDrive) event.currentTarget.focus();
            point(event, "mousePressed");
          }}
          onMouseUp={(event) => point(event, "mouseReleased")}
          onWheel={(event) => {
            if (!canDrive || !size) return;
            const rect = event.currentTarget.getBoundingClientRect();
            input({
              kind: "mouse",
              event: "mouseWheel",
              x: ((event.clientX - rect.left) / rect.width) * size.width,
              y: ((event.clientY - rect.top) / rect.height) * size.height,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
          }}
          onKeyDown={(event) => {
            if (!canDrive) return;
            event.preventDefault();
            input({
              kind: "key",
              event: "keyDown",
              key: event.key,
              code: event.code,
              text: event.key.length === 1 ? event.key : undefined,
              modifiers:
                (event.altKey ? 1 : 0) |
                (event.ctrlKey ? 2 : 0) |
                (event.metaKey ? 4 : 0) |
                (event.shiftKey ? 8 : 0),
            });
          }}
          onKeyUp={(event) =>
            input({
              kind: "key",
              event: "keyUp",
              key: event.key,
              code: event.code,
            })
          }
          style={{
            display: size ? "block" : "none",
            width: "auto",
            maxWidth: "100%",
            height: "auto",
            maxHeight: "100%",
            aspectRatio: size ? `${size.width} / ${size.height}` : undefined,
            outline: "none",
            boxShadow: "0 0 0 1px var(--border)",
            background: "#fff",
          }}
        />
        {!size && (
          <div style={{ color: "var(--text-dim)", textAlign: "center" }}>
            {busy
              ? i18n.t("panels.browser.loading")
              : i18n.t("panels.browser.empty")}
          </div>
        )}
      </div>
    </div>
  );
}
