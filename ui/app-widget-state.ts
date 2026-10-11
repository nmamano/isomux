export const APP_WIDGET_RECHECK_MS = 60_000;
export const APP_WIDGET_AUTH_COOLDOWN_MS = 60_000;
export const APP_WIDGET_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals";

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
