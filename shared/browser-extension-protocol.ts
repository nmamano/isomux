// Internal wire protocol. No page, token, or CDP payload belongs in a log.
export const BROWSER_EXTENSION_PROTOCOL = 4;
export const BROWSER_REATTACH_MS = 3000;
const BROWSER_GRANT_DURATIONS = [0, 15, 60, 240] as const;
export type BrowserGrantDuration = (typeof BROWSER_GRANT_DURATIONS)[number];
export function validGrantDuration(
  value: unknown,
): value is BrowserGrantDuration {
  return BROWSER_GRANT_DURATIONS.some((duration) => duration === value);
}
export function validGrantExpiry(
  duration: unknown,
  expiresAt: unknown,
): expiresAt is number | null {
  return (
    validGrantDuration(duration) &&
    (duration === 0
      ? expiresAt === null
      : typeof expiresAt === "number" &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > 0 &&
        expiresAt <= 8_640_000_000_000_000)
  );
}
export type BrowserGrantScope =
  | { kind: "all" }
  | { kind: "agent"; agentId: string };
export function validGrantScope(value: unknown): value is BrowserGrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.kind === "all"
    ? Object.keys(scope).length === 1
    : scope.kind === "agent" &&
        typeof scope.agentId === "string" &&
        scope.agentId.length > 0 &&
        scope.agentId.length <= 200 &&
        Object.keys(scope).length === 2;
}
export function sameGrantScope(
  a: BrowserGrantScope,
  b: BrowserGrantScope,
): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "all" || (b.kind === "agent" && a.agentId === b.agentId))
  );
}
export type Fields = Record<string, unknown>;
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
      (typeof params.frameId === "string" &&
        params.frameId.length > 0 &&
        params.frameId.length <= 200)) &&
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
  assignments: {
    id: string;
    scope: BrowserGrantScope;
    agent?: BrowserDisplay;
    durationMinutes: BrowserGrantDuration;
    expiresAt: number | null;
  }[];
}
// A reported package older than the office's is out of date; null (a hello
// without a package) is too. undefined (not seen this server run) is not.
export function extensionOutdated(
  reported: string | null | undefined,
  latest: string,
): boolean {
  if (reported === undefined) return false;
  if (reported === null) return true;
  const a = reported.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff < 0;
  }
  return false;
}
// A package version as Chrome allows it: one to four dot-separated integers.
export function validExtensionPackage(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,9}(\.\d{1,9}){0,3}$/.test(value);
}
export interface MemberBrowserStatus {
  paired: boolean;
  online: boolean;
  member: BrowserDisplay;
  version: string;
  browsers: {
    id: string;
    name: string;
    pairedAt: number | null;
    online: boolean;
    // The package the extension reported this server run; null when its hello
    // carried none (before 0.4.5). Absent until it connects.
    package?: string | null;
    outdated: boolean;
  }[];
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
  // The office's package, when it is newer than this extension.
  update?: { latest: string };
  agents: BrowserDisplay[];
  currentTab?: { id: number; eligible: boolean };
  assignments: {
    id: string;
    scope: BrowserGrantScope;
    agent?: BrowserDisplay;
    tabId: number;
    current: boolean;
    phase: "offering" | "on" | "revoking";
    durationMinutes: BrowserGrantDuration;
    expiresAt: number | null;
  }[];
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
