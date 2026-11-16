// The app frame of an app's short-link page. The server puts it in the page's
// HTML, so the app starts to load with the first response; the widget adopts
// it (ui/app-frame.ts). Both compute the frame's src here, so they agree.

// allow-popups-to-escape-sandbox: the office tab the frame opens for a page of
// the app (task 469e8886) must not inherit the frame's sandbox.
export const APP_WIDGET_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals";
// A video's full-screen button calls requestFullscreen, which the browser
// refuses inside a frame without this policy (task b0b728ed).
export const APP_WIDGET_ALLOW = "fullscreen";

// The frame the server writes into the shell, and its load flag: set by the
// shell's script when the frame loaded before the widget mounted.
export const APP_FRAME_ID = "isomux-app-frame";
export const APP_FRAME_LOADED_ATTR = "data-loaded";
// The shell script's window global: the messages that came before the widget
// listened, and the function that stops the buffering.
export const APP_FRAME_BUFFER = "__isomuxAppFrame";
export interface AppFrameBuffer {
  messages: MessageEvent[];
  stop(): void;
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
