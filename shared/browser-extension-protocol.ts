// Internal wire protocol. No page, token, or CDP payload belongs in a log.
export const BROWSER_EXTENSION_PROTOCOL = 4;
export const BROWSER_GRANT_DURATIONS = [0, 15, 60, 240] as const;
export type BrowserGrantDuration = (typeof BROWSER_GRANT_DURATIONS)[number];
export function validGrantDuration(value: unknown): value is BrowserGrantDuration {
  return BROWSER_GRANT_DURATIONS.some(duration => duration === value);
}
export function validGrantExpiry(duration: unknown, expiresAt: unknown): expiresAt is number | null {
  return validGrantDuration(duration) && (duration === 0 ? expiresAt === null :
    typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0 && expiresAt <= 8_640_000_000_000_000);
}
export type BrowserGrantScope = { kind: "all" } | { kind: "agent"; agentId: string };
export function validGrantScope(value: unknown): value is BrowserGrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.kind === "all" ? Object.keys(scope).length === 1 :
    scope.kind === "agent" && typeof scope.agentId === "string" && scope.agentId.length > 0 && scope.agentId.length <= 200 && Object.keys(scope).length === 2;
}
export function sameGrantScope(a: BrowserGrantScope, b: BrowserGrantScope): boolean {
  return a.kind === b.kind && (a.kind === "all" || (b.kind === "agent" && a.agentId === b.agentId));
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
  "DOM.getFrameOwner",
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
    (method !== "DOM.getFrameOwner" ||
      (typeof params.frameId === "string" && params.frameId.length > 0 && params.frameId.length <= 200)) &&
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
  assignments: { id: string; scope: BrowserGrantScope; agent?: BrowserDisplay; durationMinutes: BrowserGrantDuration; expiresAt: number | null }[];
}
export interface MemberBrowserStatus {
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
  assignments: { id: string; scope: BrowserGrantScope; agent?: BrowserDisplay; tabId: number; current: boolean; phase: "offering" | "on" | "revoking"; durationMinutes: BrowserGrantDuration; expiresAt: number | null }[];
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
