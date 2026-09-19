// Internal wire protocol. No page, token, or CDP payload belongs in a log.
export const BROWSER_EXTENSION_PROTOCOL = 3;
export const BROWSER_GRANT_DURATIONS = [0, 15, 60, 240] as const;
export type BrowserGrantDuration = (typeof BROWSER_GRANT_DURATIONS)[number];
export function validGrantDuration(value: unknown): value is BrowserGrantDuration {
  return BROWSER_GRANT_DURATIONS.some(duration => duration === value);
}
export function validGrantExpiry(duration: unknown, expiresAt: unknown): expiresAt is number | null {
  return validGrantDuration(duration) && (duration === 0 ? expiresAt === null :
    typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0 && expiresAt <= 8_640_000_000_000_000);
}
export type Fields = Record<string, unknown>;
export interface ExtensionCommand {
  kind: "command";
  generation: string;
  id: number;
  assignment: string;
  method: "attach" | "cdp" | "detach";
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
  "Page.stopLoading",
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

export interface BrowserDisplay {
  id: string;
  name: string;
}
export interface BrowserMetadata {
  agents: BrowserDisplay[];
  member: BrowserDisplay;
  assignments: { id: string; agent: BrowserDisplay; durationMinutes: BrowserGrantDuration; expiresAt: number | null }[];
}
export interface MemberBrowserStatus {
  backend: "headless" | "extension" | null;
  selectionRequired: boolean;
  paired: boolean;
  online: boolean;
  member: BrowserDisplay;
  version: string;
}
export interface ExtensionUIState {
  office: string;
  state:
    | "unpaired"
    | "offline"
    | "connecting"
    | "connected"
    | "disabled"
    | "blocked"
    | "unknown";
  member?: BrowserDisplay;
  agents: BrowserDisplay[];
  currentTab?: { id: number; eligible: boolean };
  assignments: { id: string; agent: BrowserDisplay; tabId: number; current: boolean; phase: "offering" | "on" | "revoking"; durationMinutes: BrowserGrantDuration; expiresAt: number | null }[];
}
export function officeSocketURL(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    /[?#@]/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new Error(
      "Enter an HTTPS office address without a path, query or fragment.",
    );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/browser-extension/ws";
  return url.href;
}
