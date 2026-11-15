// Pure helpers of the extension bridge (browser-extension-bridge.ts).
import {
  BROWSER_DETACH_CAUSES,
  type Fields,
} from "../shared/browser-extension-protocol";

export function listen(
  map: Map<string, Set<() => void>>,
  grant: string,
  listener: () => void,
): () => void {
  let listeners = map.get(grant);
  if (!listeners) map.set(grant, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && map.get(grant) === listeners) map.delete(grant);
  };
}

// Playwright sends a screenshot clip in CSS px, but Chrome reads the clip in
// DIPs (CDP Page.Viewport), which are CSS px times the page zoom (Cmd +).
// Unscaled, a shot of a zoomed tab showed only part of the view, or the view
// with a blank band. Scale the clip by the zoom of the capture's own page.
export function clipInDips(params: Fields, metrics: Fields): Fields {
  const zoom = (metrics.cssVisualViewport as Fields | undefined)?.zoom;
  const clip = params.clip as Fields;
  if (
    typeof zoom !== "number" ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    zoom === 1 ||
    typeof clip !== "object" ||
    clip === null
  )
    return params;
  const scaled: Fields = { ...clip };
  for (const key of ["x", "y", "width", "height"]) {
    const value = clip[key];
    if (typeof value === "number") scaled[key] = value * zoom;
  }
  return { ...params, clip: scaled };
}

// The extension's cause in a "detached" event, when it is one from the list.
export function extensionCause(params: unknown): Fields {
  const cause =
    params && typeof params === "object" ? (params as Fields).cause : undefined;
  return BROWSER_DETACH_CAUSES.some((known) => known === cause)
    ? { extensionCause: cause }
    : {};
}

// The routing fields of an extension message, for a log line: never its
// params or result, which can carry page content.
export function envelope(msg: Fields): Fields {
  return {
    ...(typeof msg.kind === "string" ? { kind: msg.kind } : {}),
    ...(typeof msg.id === "number" ? { id: msg.id } : {}),
    ...(typeof msg.method === "string" ? { method: msg.method } : {}),
    ...(typeof msg.assignment === "string"
      ? { assignment: msg.assignment }
      : {}),
  };
}
