import { useEffect, useRef, type RefObject } from "react";
import {
  APP_FRAME_BUFFER,
  APP_FRAME_ID,
  APP_FRAME_LOADED_ATTR,
  APP_WIDGET_ALLOW,
  APP_WIDGET_SANDBOX,
  type AppFrameBuffer,
} from "../shared/app-widget-frame.ts";

// The app frame of the short-link page (task ac70b38c). The server writes it
// into the shell before #root (shared/app-widget-frame.ts), so the app loads
// while the office bundle loads; the widget adopts that element and never
// loads it again. Without one (no live app session at shell time) the hook
// makes the frame at the same place.
//
// src: the page the frame shows; null removes the frame. The hook writes src
// only when it differs from the last src it applied (for the adopted frame,
// adoptedSrc). frameKey: a new key puts a new frame in place of the old one.
// onLoad runs once per frame load, also for a load before the hook ran.
// The hook removes its frame on unmount.
export function useAppFrame(options: {
  src: string | null;
  adoptedSrc: string | null;
  frameKey: number;
  title: string;
  onLoad: () => void;
}): RefObject<HTMLIFrameElement | null> {
  const { src, adoptedSrc, frameKey, title, onLoad } = options;
  const frame = useRef<HTMLIFrameElement | null>(null);
  // The src last written, as written: the browser normalizes el.src.
  const applied = useRef<string | null>(null);
  const shownKey = useRef<number | null>(null);
  const loaded = useRef(onLoad);
  useEffect(() => {
    loaded.current = onLoad;
  });

  useEffect(() => {
    const remove = () => {
      frame.current?.remove();
      frame.current = null;
      applied.current = null;
      shownKey.current = null;
    };
    if (src === null) {
      remove();
      return;
    }
    if (frame.current && shownKey.current === frameKey) {
      if (applied.current !== src) {
        frame.current.src = src;
        applied.current = src;
      }
      return;
    }
    const shell =
      frame.current === null ? document.getElementById(APP_FRAME_ID) : null;
    if (shell instanceof HTMLIFrameElement && adoptedSrc !== null) {
      frame.current = shell;
      applied.current = adoptedSrc;
      shownKey.current = frameKey;
      shell.addEventListener("load", () => loaded.current());
      // A load before the widget listened, marked by the shell's script.
      if (shell.hasAttribute(APP_FRAME_LOADED_ATTR)) loaded.current();
      if (applied.current !== src) {
        shell.src = src;
        applied.current = src;
      }
      return;
    }
    remove();
    const made = document.createElement("iframe");
    made.className = "app-widget-frame";
    made.title = title;
    made.setAttribute("sandbox", APP_WIDGET_SANDBOX);
    made.setAttribute("allow", APP_WIDGET_ALLOW);
    made.addEventListener("load", () => loaded.current());
    made.src = src;
    // First in the page, as the shell puts it: the widget's overlays paint
    // above it.
    document.body.insertBefore(made, document.body.firstChild);
    frame.current = made;
    applied.current = src;
    shownKey.current = frameKey;
  }, [src, adoptedSrc, frameKey, title]);

  useEffect(
    () => () => {
      frame.current?.remove();
      frame.current = null;
    },
    [],
  );
  return frame;
}

// The window messages the shell held for the widget until it listened; stops
// the holding. Empty when the shell held none.
export function takeBufferedFrameMessages(): MessageEvent[] {
  const global = window as unknown as Record<
    string,
    AppFrameBuffer | undefined
  >;
  const held = global[APP_FRAME_BUFFER];
  if (!held) return [];
  Reflect.deleteProperty(window, APP_FRAME_BUFFER);
  held.stop();
  return held.messages;
}
