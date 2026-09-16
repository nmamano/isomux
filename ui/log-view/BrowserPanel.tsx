import { useCallback, useEffect, useRef, useState } from "react";
import {
  addRawListener,
  removeRawListener,
  addBinaryListener,
  removeBinaryListener,
  send,
} from "../ws.ts";
import { useI18n } from "../i18n.tsx";
import {
  BROWSER_MIN_DIM,
  BROWSER_MAX_DIM,
  type BrowserHumanInput,
  type BrowserNavigation,
  type ServerMessage,
} from "../../shared/types.ts";

import {
  decodeBrowserFrame,
  type BinaryBrowserFrame,
} from "../../shared/browser-frame.ts";

type Frame =
  | { data: string; width: number; height: number }
  | BinaryBrowserFrame;
let nextWatchGeneration = 0;
let nextSelectionRequest = 0;

/** Mounted only for the chat being viewed; background chats cannot open a panel. */
export function useBrowserAutoOpen(
  agentId: string,
  canDrive: boolean,
  enabled: boolean,
  open: () => void,
) {
  useEffect(() => {
    if (!canDrive || !enabled) return;
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
  }, [agentId, canDrive, enabled, open]);
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
  const [busy, setBusy] = useState(canDrive);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyNote, setCopyNote] = useState("");
  const selectionRequest = useRef<{
    id: number;
    resolve: (value: { text: string; truncated: boolean }) => void;
    reject: () => void;
  } | null>(null);
  const editing = useRef(false);
  const lastServerUrl = useRef<string | undefined>(undefined);
  const surfaceRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const captureBounds = useRef<{ maxWidth?: number; maxHeight?: number }>({});
  const pageBounds = useRef<{ width: number; height: number } | null>(null);
  const held = useRef<{ x: number; y: number } | null>(null);
  const motion = useRef<BrowserHumanInput | null>(null);
  const motionTick = useRef<number | null>(null);

  const input = useCallback(
    (value: BrowserHumanInput) => {
      if (canDrive) send({ type: "browser_input", agentId, input: value });
    },
    [agentId, canDrive],
  );

  useEffect(() => {
    const listener = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      const request = selectionRequest.current;
      if (
        !request ||
        message.type !== "browser_selection" ||
        message.agentId !== agentId ||
        message.requestId !== request.id
      )
        return;
      if (message.error) request.reject();
      else request.resolve(message);
    };
    addRawListener(listener);
    return () => {
      removeRawListener(listener);
      selectionRequest.current?.reject();
      selectionRequest.current = null;
    };
  }, [agentId, canDrive]);

  const copySelection = async () => {
    if (!canDrive || selectionRequest.current) return;
    setCopyNote("");
    setError("");
    if (!navigator.clipboard?.writeText) {
      setError(i18n.t("panels.browser.copyFailed"));
      return;
    }
    setCopying(true);
    const id = ++nextSelectionRequest;
    const isCurrent = () => selectionRequest.current?.id === id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = true;
    try {
      const selection = await new Promise<{ text: string; truncated: boolean }>(
        (resolve, reject) => {
          selectionRequest.current = {
            id,
            resolve,
            reject: () => reject(new Error("selection_failed")),
          };
          timer = setTimeout(
            () => reject(new Error("selection_timeout")),
            5000,
          );
          input({ kind: "selection", requestId: id });
        },
      );
      if (!isCurrent()) return;
      if (!selection.text) {
        setCopyNote(i18n.t("panels.browser.noSelection"));
        return;
      }
      reading = false;
      await navigator.clipboard.writeText(selection.text);
      if (isCurrent())
        setCopyNote(
          i18n.t(
            selection.truncated
              ? "panels.browser.copyTruncated"
              : "panels.browser.copied",
          ),
        );
    } catch {
      if (isCurrent())
        setError(
          i18n.t(
            reading
              ? "panels.browser.selectionFailed"
              : "panels.browser.copyFailed",
          ),
        );
    } finally {
      if (timer) clearTimeout(timer);
      if (isCurrent()) {
        selectionRequest.current = null;
      }
      setCopying(false);
    }
  };

  const navigate = useCallback(
    (action: BrowserNavigation["action"], nextUrl?: string) => {
      if (!canDrive) return;
      setBusy(true);
      setError("");
      setCopyNote("");
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
    let watchGeneration = 0;
    let acceptsFrames = true;
    let pageAvailable = false;
    let binary = typeof createImageBitmap === "function";
    let decodeFailures = 0;
    // Watch generation rejects frames from a replaced subscription (including
    // resize). Decode epoch also invalidates an in-flight image on unavailable;
    // acceptsFrames blocks CURRENT-watch frames until status becomes available.
    // One image decode and one replaceable pending frame. A slow viewer cannot
    // accumulate old images behind the current page.
    const decode = () => {
      if (!alive || decoding || !pending) return;
      const frame = pending;
      pending = null;
      decoding = true;
      const epoch = generation;
      const finish = () => {
        decoding = false;
        decode();
      };
      const paint = (
        image: CanvasImageSource,
        width: number,
        height: number,
      ) => {
        if (!alive || epoch !== generation || !surfaceRef.current) return;
        const canvas = surfaceRef.current;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
        setSize((old) =>
          old?.width === frame.width && old.height === frame.height
            ? old
            : { width: frame.width, height: frame.height },
        );
      };
      if ("jpeg" in frame) {
        void createImageBitmap(new Blob([frame.jpeg], { type: "image/jpeg" }))
          .then(
            (bitmap) => {
              decodeFailures = 0;
              // A decode can finish after resize, close or unmount. Every
              // resolved bitmap is owned here, even when painting is skipped.
              try {
                paint(bitmap, bitmap.width, bitmap.height);
              } catch {
              } finally {
                bitmap.close();
              }
            },
            () => {
              // One corrupt frame does not change transport. Repeated decoder
              // failure uses the same JSON/Image path as an older browser.
              if (alive && epoch === generation && ++decodeFailures >= 3) {
                binary = false;
                subscribe();
              }
            },
          )
          .finally(finish);
        return;
      }
      const image = new Image();
      image.onload = () => {
        try {
          paint(
            image,
            image.naturalWidth || frame.width,
            image.naturalHeight || frame.height,
          );
        } finally {
          finish();
        }
      };
      image.onerror = finish;
      image.src = `data:image/jpeg;base64,${frame.data}`;
    };
    const resizePage = () => {
      if (pageAvailable && pageBounds.current)
        input({ kind: "viewport", ...pageBounds.current });
    };
    const subscribe = () => {
      watchGeneration = ++nextWatchGeneration;
      generation++;
      pending = null;
      send({
        ...(binary
          ? { transport: "jpeg-v1" as const, generation: watchGeneration }
          : {}),
        type: "browser_watch",
        agentId,
        watching: true,
        ...captureBounds.current,
      });
    };
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
              const cssBound = (value: number) =>
                Math.max(
                  BROWSER_MIN_DIM,
                  Math.min(BROWSER_MAX_DIM, Math.round(value)),
                );
              const page = {
                width: cssBound(rect.width),
                height: cssBound(rect.height),
              };
              const pageChanged =
                page.width !== pageBounds.current?.width ||
                page.height !== pageBounds.current?.height;
              pageBounds.current = page;
              if (
                next.maxWidth === captureBounds.current.maxWidth &&
                next.maxHeight === captureBounds.current.maxHeight
              ) {
                if (pageChanged) resizePage();
                return;
              }
              captureBounds.current = next;
              subscribe();
              if (pageChanged) resizePage();
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
        if (!acceptsFrames) return;
        setSize((old) =>
          old?.width === message.width && old.height === message.height
            ? old
            : { width: message.width, height: message.height },
        );
        pending = message;
        decode();
      } else if (message.type === "browser_status") {
        const opened = message.available && !pageAvailable;
        pageAvailable = message.available;
        if (opened) resizePage();
        acceptsFrames = message.available && !message.resizing;
        if (message.resizing) {
          pending = null;
          generation++;
        }
        setAvailable(message.available);
        if (message.url !== undefined) {
          if (message.url !== lastServerUrl.current) setCopyNote("");
          lastServerUrl.current = message.url;
          if (!editing.current)
            setUrl(message.url === "about:blank" ? "" : message.url);
        }
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
    const binaryListener = (raw: ArrayBuffer) => {
      const frame = decodeBrowserFrame(raw);
      if (
        !binary ||
        !frame ||
        !acceptsFrames ||
        frame.agentId !== agentId ||
        frame.generation !== watchGeneration
      )
        return;
      pending = frame;
      decode();
    };
    addBinaryListener(binaryListener);
    addRawListener(listener);
    subscribe();
    if (canDrive) input({ kind: "navigate", action: "open" });
    return () => {
      alive = false;
      removeBinaryListener(binaryListener);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      pending = null;
      send({ type: "browser_watch", agentId, watching: false });
      removeRawListener(listener);
    };
  }, [agentId, canDrive, input]);

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

  const releaseHeld = useCallback(() => {
    if (!held.current) return;
    flushMotion();
    input({
      kind: "mouse",
      event: "mouseReleased",
      ...held.current,
      button: "left",
      clickCount: 1,
    });
    held.current = null;
  }, [flushMotion, input]);
  useEffect(() => {
    window.addEventListener("blur", releaseHeld);
    return () => {
      window.removeEventListener("blur", releaseHeld);
      releaseHeld();
    };
  }, [releaseHeld]);

  const coordinates = (
    event: React.MouseEvent<HTMLCanvasElement>,
    clamp = false,
  ) => {
    if (!size) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / size.width, rect.height / size.height);
    if (!scale) return null;
    const x =
      (event.clientX - rect.left - (rect.width - size.width * scale) / 2) /
      scale;
    const y =
      (event.clientY - rect.top - (rect.height - size.height * scale) / 2) /
      scale;
    if (!clamp && (x < 0 || y < 0 || x > size.width || y > size.height))
      return null;
    return {
      x: Math.max(0, Math.min(size.width, x)),
      y: Math.max(0, Math.min(size.height, y)),
    };
  };
  const point = (
    event: React.PointerEvent<HTMLCanvasElement>,
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
  ) => {
    if (!canDrive || !size) return;
    const position = coordinates(event, held.current !== null);
    if (!position) return;
    if (type === "mousePressed" || held.current) held.current = position;
    const value: BrowserHumanInput = {
      kind: "mouse",
      event: type,
      ...position,
      button: type === "mouseMoved" && !(event.buttons & 1) ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    };
    if (type === "mouseMoved") {
      motion.current = value;
      if (motionTick.current === null)
        motionTick.current = requestAnimationFrame(flushMotion);
    } else {
      flushMotion();
      input(value);
      if (type === "mouseReleased") held.current = null;
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
            disabled={!available || busy || copying}
            onClick={() => void copySelection()}
          >
            {i18n.t("panels.browser.copySelection")}
          </button>
        )}
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
          copyNote ||
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
          background: "var(--bg-code)",
          overflow: "hidden",
        }}
      >
        <canvas
          ref={surfaceRef}
          role="application"
          aria-label={i18n.t("panels.browser.surface")}
          tabIndex={canDrive ? 0 : -1}
          onPointerMove={(event) => point(event, "mouseMoved")}
          onPointerDown={(event) => {
            if (!canDrive || event.button !== 0 || !coordinates(event)) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            point(event, "mousePressed");
          }}
          onPointerUp={(event) => {
            if (event.button !== 0) return;
            point(event, "mouseReleased");
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={releaseHeld}
          onLostPointerCapture={releaseHeld}
          onWheel={(event) => {
            if (!canDrive || !size) return;
            const position = coordinates(event);
            if (!position) return;
            input({
              kind: "mouse",
              event: "mouseWheel",
              ...position,
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
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            objectFit: "contain",
            touchAction: "none",
            outline: "none",
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
