// Internal wire protocol. No page, token, or CDP payload belongs in a log.
export const BROWSER_EXTENSION_PROTOCOL = 1;
export type Fields = Record<string, unknown>;
export interface ExtensionCommand {
  kind: "command";
  generation: string;
  id: number;
  assignment: string;
  method: "create" | "cdp" | "detach";
  params: Fields;
}
export interface BridgePeer {
  send(message: Fields): void;
  close(): void;
}
export function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid browser message");
  return value as Fields;
}

export function browserSocketURL(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(url.protocol === "wss:" || (url.protocol === "ws:" && loopback))
  ) {
    throw new Error("Invalid browser connection URL");
  }
  return url.href;
}

// These methods act on an already owned page session. In particular, no
// browser-wide cookie/storage operation or arbitrary Target command passes.
const PAGE_COMMANDS = new Set([
  "Page.enable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.setInterceptFileChooserDialog",
  "Page.bringToFront",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.addBinding",
  "Runtime.removeBinding",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getContentQuads",
  "DOM.getBoxModel",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "Log.enable",
  "Network.enable",
  "Network.getResponseBody",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.dispatchTouchEvent",
  "Input.synthesizeScrollGesture",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setDefaultBackgroundColorOverride",
  "Target.setAutoAttach",
]);
export function pageCommandAllowed(method: string, params: Fields): boolean {
  return (
    PAGE_COMMANDS.has(method) &&
    !("targetId" in params) &&
    !("browserContextId" in params)
  );
}
