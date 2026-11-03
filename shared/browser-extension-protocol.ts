// Internal wire protocol. No page, token, or CDP payload belongs in a log.
export const BROWSER_EXTENSION_PROTOCOL = 4;
// The oldest protocol the extension speaks. The Chrome Web Store pushes the
// newest extension to every office back to v2026.9.22, which speaks only 4, so
// this stays 4. The hello carries version EXTENSION_MIN_PROTOCOL and
// maxVersion BROWSER_EXTENSION_PROTOCOL; a bump of BROWSER_EXTENSION_PROTOCOL
// keeps the server's hello check accepting EXTENSION_MIN_PROTOCOL, and the
// office answers in the highest version both speak.
export const EXTENSION_MIN_PROTOCOL = 4;
// The first extension package that takes the mute command.
export const EXTENSION_MUTE_PACKAGE = "0.8.0";
export const BROWSER_REATTACH_MS = 3000;
// How long the extension waits for each command when it attaches to or
// releases a tab. A tab that shows a JavaScript dialog answers none, and only
// the debugger session that saw the dialog open can close it.
export const ATTACH_ANSWER_MS = 5000;
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
// Who may open tabs in a browser whose member turned on agent tabs: "all" is
// the agents the member manages, "office" every agent the member can reach.
export type AgentTabsScope = "all" | "office";
export function validAgentTabsScope(
  value: unknown,
): value is AgentTabsScope | null {
  return value === null || value === "all" || value === "office";
}
const validAgentId = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
// Which agents may use a browser, for its offered tabs and the tabs agents
// open: "mine" the agents the member manages, "members" also those of the
// picked members, "office" every agent the member can reach. members stays
// stored under the other values, so a switch back keeps the picks.
export interface BrowserAccess {
  agents: "mine" | "members" | "office";
  members: string[];
  openTabs: boolean;
}
// Members are unique non-empty ids of at most 200 characters, at most 200 of
// them. The bridge refuses an invalid access message the way it refuses an
// invalid agentTabs message: it throws and the connection closes.
export function validBrowserAccess(value: unknown): value is BrowserAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  const members = access.members;
  return (
    Object.keys(access).length === 3 &&
    (access.agents === "mine" ||
      access.agents === "members" ||
      access.agents === "office") &&
    typeof access.openTabs === "boolean" &&
    Array.isArray(members) &&
    members.length <= 200 &&
    members.every(validAgentId) &&
    new Set(members).size === members.length
  );
}
// "all" is every agent the member manages (the name stays for stored and
// resumed offers); "office" is every agent the member can reach. "shared" is
// whoever the browser's current access admits. "opened" is a tab that the
// agent opened itself; via is the agent tabs scope that let it.
export type BrowserGrantScope =
  | { kind: "all" }
  | { kind: "office" }
  | { kind: "shared" }
  | { kind: "agent"; agentId: string }
  | { kind: "opened"; agentId: string; via: AgentTabsScope };
export function validGrantScope(value: unknown): value is BrowserGrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (
    scope.kind === "all" ||
    scope.kind === "office" ||
    scope.kind === "shared"
  )
    return Object.keys(scope).length === 1;
  if (scope.kind === "agent")
    return validAgentId(scope.agentId) && Object.keys(scope).length === 2;
  return (
    scope.kind === "opened" &&
    validAgentId(scope.agentId) &&
    (scope.via === "all" || scope.via === "office") &&
    Object.keys(scope).length === 3
  );
}
export function sameGrantScope(
  a: BrowserGrantScope,
  b: BrowserGrantScope,
): boolean {
  if (a.kind === "agent") return b.kind === "agent" && a.agentId === b.agentId;
  if (a.kind === "opened")
    return b.kind === "opened" && a.agentId === b.agentId && a.via === b.via;
  return a.kind === b.kind;
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

// The office's kick for a stuck capture (server/browser-extension-bridge.ts).
// Only the office sends these, on a tab or popup session: a client cannot, as
// they are not page commands. Chrome sends one frame at most without an ack.
export const SCREENCAST_KICK_PARAMS = {
  format: "jpeg",
  quality: 1,
  maxWidth: 16,
  maxHeight: 16,
} as const;
export function screencastKickCommand(method: unknown): boolean {
  return method === "Page.startScreencast" || method === "Page.stopScreencast";
}

export interface BrowserDisplay {
  id: string;
  name: string;
}
export interface BrowserMetadata {
  agents: BrowserDisplay[];
  // Members other than this one who manage an agent the member can reach,
  // and every picked member. Absent from an older office.
  members?: BrowserDisplay[];
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
// The extension's Chrome Web Store listing; null until the first listing.
export const CHROME_WEB_STORE_URL: string | null = null;
// A Chrome Web Store listing URL: https://chromewebstore.google.com/detail/...
export function validStoreUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === "https://chromewebstore.google.com" &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith("/detail/")
  );
}
// Chrome updates the extension itself: an install from the store, also by
// policy. An unpacked or ZIP install is "development".
export function storeInstall(installType: unknown): boolean {
  return typeof installType === "string" && installType !== "development";
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
  // The extension's store listing, when there is one.
  storeUrl?: string;
  browsers: {
    id: string;
    name: string;
    pairedAt: number | null;
    online: boolean;
    // Its hello this server run said it is a store install.
    store?: boolean;
    // The package the extension reported this server run; null when its hello
    // carried none (before 0.4.5). Absent until it connects.
    package?: string | null;
    outdated: boolean;
    // Online, with newer extension files on disk than the version it runs:
    // POST .../browsers/:id/reload loads them.
    reloadable: boolean;
    // Whose agents may open tabs in it, while it is online; else null. "all"
    // is the member's own agents, "members" also those of the picked members.
    agentTabs: "all" | "members" | "office" | null;
    // The picked members, when agentTabs is "members".
    members?: BrowserDisplay[];
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
  // This extension is a store install (storeInstall).
  store?: boolean;
  // The store listing the office sent in ready, when valid.
  storeUrl?: string;
  agents: BrowserDisplay[];
  // The office accepts offers to every agent the member can reach.
  officeScope?: boolean;
  // The office takes agent tabs.
  agentTabs?: boolean;
  // While connected: the member's access setting for this browser.
  access?: BrowserAccess;
  // The members the member can pick (BrowserMetadata.members).
  members: BrowserDisplay[];
  // The office takes access messages and "shared" offers.
  sharedAccess?: boolean;
  currentTab?: { id: number; eligible: boolean };
  assignments: {
    id: string;
    scope: BrowserGrantScope;
    agent?: BrowserDisplay;
    // A tab opened by another member's agent: the name of its manager.
    manager?: { name: string };
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

/** The origin of an http(s) URL, or undefined. */
export function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

// Why the extension ended an offer, in its "detached" event (params.cause).
export const BROWSER_DETACH_CAUSES = [
  "off",
  "office",
  "offer_refused",
  "metadata",
  "recovery_failed",
  "debugger_detached",
  "too_large",
] as const;
export type BrowserDetachCause = (typeof BROWSER_DETACH_CAUSES)[number];
// Why the extension could not attach to an offered tab, in the attach
// command's failed result (reason).
export const BROWSER_ATTACH_FAILURES = [
  "already_attached",
  "tab_unavailable",
  "unanswered",
  "ended",
  "attach_failed",
  // An open the member's agent tabs setting does not allow.
  "agent_tabs_off",
] as const;
export type BrowserAttachFailure = (typeof BROWSER_ATTACH_FAILURES)[number];

// The largest extension message the office takes whole.
export const EXTENSION_MAX_BYTES = 8 * 1024 * 1024;
/** The UTF-8 size of text, in bytes, with no copy of it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
// The longest string an oversized event keeps (task a42c729b).
const EVENT_STRING_CAP = 64 * 1024;

// Cuts every long string in a value, in place. A cut keeps the origin the
// office gate reads, so a long string whose prefix has another origin (a URL
// with long userinfo) stays whole.
function cutStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= EVENT_STRING_CAP) return value;
    const cut = value.slice(0, EVENT_STRING_CAP);
    return httpOrigin(cut) === httpOrigin(value) ? cut : value;
  }
  if (Array.isArray(value))
    for (let i = 0; i < value.length; i++) value[i] = cutStrings(value[i]);
  else if (value && typeof value === "object")
    for (const [key, field] of Object.entries(value))
      (value as Fields)[key] = cutStrings(field);
  return value;
}

// An event over EXTENSION_MAX_BYTES without its request body and with its long
// strings cut, or undefined when it is still over the cap. It changes msg in
// place. Playwright reads the body only for Request.postData(); hasPostData
// stays.
export function trimOversizedEvent(msg: Fields): Fields | undefined {
  if (msg.params && typeof msg.params === "object") {
    if (msg.method === "Network.requestWillBeSent") {
      const request = (msg.params as Fields).request;
      if (request && typeof request === "object") {
        delete (request as Fields).postData;
        delete (request as Fields).postDataEntries;
      }
    }
    cutStrings(msg.params);
  }
  return utf8Bytes(JSON.stringify(msg)) > EXTENSION_MAX_BYTES ? undefined : msg;
}
