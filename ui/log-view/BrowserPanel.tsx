import { useCallback, useEffect, useRef, useState } from "react";
import { addRawListener, removeRawListener, send } from "../ws.ts";
import { useI18n } from "../i18n.tsx";
import type { ServerMessage } from "../../shared/types.ts";

export function BrowserPanel({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const [frame, setFrame] = useState<{ data: string; width: number; height: number } | null>(null);
  const surfaceRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const listener = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "browser_frame" && message.agentId === agentId) {
        setFrame({ data: message.data, width: message.width, height: message.height });
      } else if (
        message.type === "browser_status" &&
        message.agentId === agentId &&
        !message.available
      ) {
        setFrame(null);
      } else if (message.type === "full_state") {
        // The server drops subscriptions with the old socket. A mounted panel
        // survives the reconnect, so subscribe again after fresh hydration.
        send({ type: "browser_watch", agentId, watching: true });
      }
    };
    addRawListener(listener);
    send({ type: "browser_watch", agentId, watching: true });
    return () => {
      send({ type: "browser_watch", agentId, watching: false });
      removeRawListener(listener);
    };
  }, [agentId]);

  useEffect(() => {
    if (!frame || !surfaceRef.current) return;
    const canvas = surfaceRef.current;
    const image = new Image();
    image.onload = () => {
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.getContext("2d")?.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, [frame]);

  const point = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>, type: "mousePressed" | "mouseReleased" | "mouseMoved") => {
      if (!frame) return;
      const rect = event.currentTarget.getBoundingClientRect();
      send({
        type: "browser_input",
        agentId,
        input: {
          kind: "mouse",
          event: type,
          x: ((event.clientX - rect.left) / rect.width) * frame.width,
          y: ((event.clientY - rect.top) / rect.height) * frame.height,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        },
      });
    },
    [agentId, frame],
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-base)", borderLeft: "1px solid var(--border)" }}>
      <div style={{ height: 42, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", borderBottom: "1px solid var(--border)" }}>
        <strong>{i18n.t("panels.browser.title")}</strong>
        <button type="button" onClick={onClose} aria-label={i18n.t("panels.browser.close")} title={i18n.t("panels.browser.close")} style={{ border: 0, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 20 }}>×</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 10, background: "var(--bg-code)" }}>
        {frame ? (
          <canvas
            ref={surfaceRef}
            role="application"
            aria-label={i18n.t("panels.browser.surface")}
            tabIndex={0}
            onMouseMove={(event) => point(event, "mouseMoved")}
            onMouseDown={(event) => { event.currentTarget.focus(); point(event, "mousePressed"); }}
            onMouseUp={(event) => point(event, "mouseReleased")}
            onWheel={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              send({ type: "browser_input", agentId, input: { kind: "mouse", event: "mouseWheel", x: ((event.clientX - rect.left) / rect.width) * frame.width, y: ((event.clientY - rect.top) / rect.height) * frame.height, deltaX: event.deltaX, deltaY: event.deltaY } });
            }}
            onKeyDown={(event) => {
              event.preventDefault();
              send({ type: "browser_input", agentId, input: { kind: "key", event: "keyDown", key: event.key, code: event.code, text: event.key.length === 1 ? event.key : undefined, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) } });
            }}
            onKeyUp={(event) => send({ type: "browser_input", agentId, input: { kind: "key", event: "keyUp", key: event.key, code: event.code } })}
            style={{ width: "100%", maxHeight: "100%", aspectRatio: `${frame.width} / ${frame.height}`, outline: "none", boxShadow: "0 0 0 1px var(--border)", background: "#fff" }}
          />
        ) : (
          <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 24 }}>{i18n.t("panels.browser.waiting")}</div>
        )}
      </div>
    </div>
  );
}
