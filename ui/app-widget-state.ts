import type { AppView } from "../shared/contract-shapes.ts";

export const APP_WIDGET_RECHECK_MS = 60_000;
export const APP_VIEW_MESSAGE = "isomux:app-view";
export const APP_RELOAD_MESSAGE = "isomux:app-reload";
// After a turn that changed the app, how often and how long the widget waits
// for the app to serve before it reloads the frame.
export const APP_RELOAD_POLL_MS = 1000;
export const APP_RELOAD_POLL_TRIES = 60;
// How long an in-place reload request waits for the frame to load before the
// widget mounts a new frame instead.
export const APP_RELOAD_FALLBACK_MS = 5000;
const APP_WIDGET_AUTH_COOLDOWN_MS = 60_000;
// allow-popups-to-escape-sandbox: the office tab the frame opens for a page of
// the app (task 469e8886) must not inherit the frame's sandbox.
export const APP_WIDGET_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals";

export interface AppWidgetBoot {
  name: string;
  registration: number;
}

export function widgetDraftKey(boot: AppWidgetBoot, agentId: string): string {
  return `app-widget:draft:${boot.name}:${boot.registration}:${agentId}`;
}

export function isAppSessionSignal(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frameWindow: Window | null,
  appUrl: string | null,
): boolean {
  return (
    frameWindow !== null &&
    appUrl !== null &&
    event.source === frameWindow &&
    event.origin === new URL(appUrl).origin &&
    event.data === "isomux:app-session-required"
  );
}

// The frame's report of the page it shows (task d7ac4f73): sent by the script
// the app proxy appends to a framed page. The view a report carries, or null
// when the event is not one from this app's frame. Only path and title are
// read; the label on the server bounds and quotes them.
export function isAppViewReport(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frameWindow: Window | null,
  appUrl: string | null,
): AppView | null {
  if (
    frameWindow === null ||
    appUrl === null ||
    event.source !== frameWindow ||
    event.origin !== new URL(appUrl).origin
  )
    return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || data.type !== APP_VIEW_MESSAGE)
    return null;
  const { path, title } = data;
  if (typeof path !== "string") return null;
  if (title !== undefined && typeof title !== "string") return null;
  return title === undefined ? { path } : { path, title };
}

// The path a frame src opens: what the widget sends before any report.
export function framePath(frameUrl: string): string {
  const url = new URL(frameUrl);
  return url.pathname + url.search + url.hash;
}

// The app page a widget address names (task 469e8886): /<app>/blog?x#y names
// /blog?x#y, and /<app> or /<app>/ the root.
export function widgetAppPath(
  name: string,
  pathname: string,
  search: string,
  hash: string,
): string {
  const page = pathname.slice(name.length + 1) || "/";
  return page + search + hash;
}

// The frame's src: the given page, when it is on the app, or else the page
// the widget address names. A path such as //other.example must not move the
// frame off the app: it falls back to the root.
export function frameStart(
  appUrl: string,
  startPath: string,
  page?: string | null,
): string {
  const onApp = (path: string) => {
    try {
      const url = new URL(path, appUrl + "/");
      if (url.origin === new URL(appUrl).origin) return url.href;
    } catch {
      // Not a path.
    }
    return null;
  };
  return (page ? onApp(page) : null) ?? onApp(startPath || "/") ?? appUrl + "/";
}

export function beginAppHandshake(
  storage: Pick<Storage, "getItem" | "setItem">,
  boot: AppWidgetBoot,
  now: number,
): boolean {
  const key = `app-widget:handshake:${boot.name}:${boot.registration}`;
  try {
    const last = Number(storage.getItem(key));
    if (last > 0 && now - last < APP_WIDGET_AUTH_COOLDOWN_MS) return false;
    storage.setItem(key, String(now));
    return true;
  } catch {
    return false;
  }
}

export function screenshotHint(
  platform: string,
  userAgent: string,
  maxTouchPoints: number,
) {
  if (
    /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (/Mac/i.test(platform) && maxTouchPoints > 1)
  )
    return "appWidget.genericHint";
  if (/Win/i.test(platform)) return "appWidget.windowsHint";
  if (/Mac/i.test(platform)) return "appWidget.macHint";
  return "appWidget.genericHint";
}
