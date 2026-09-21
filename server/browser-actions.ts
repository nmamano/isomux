import type { BrowserGrantScope } from "../shared/browser-extension-protocol";
import { MAX_FRAME_DEPTH } from "./browser-frames";
// Desktop Chrome action contract. Screenshot previews use preview-capture.ts.
import { validUploadPath, type UploadedFile } from "./browser-upload";
export const BROWSER_ACTION_DEADLINE_MS = 30_000;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_URL_LEN = 2048;
const MAX_SELECTOR_LEN = 500;
const MAX_FILL_LEN = 10_000;
const MIN_DIM = 320;
const MAX_DIM = 2560;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

export const BROWSER_ACTIONS = [
  "tabs",
  "goto",
  "snapshot",
  "text",
  "click",
  "fill",
  "upload",
  "press",
  "screenshot",
  "close",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export type BrowserErrorCode =
  | "browser_target_required"
  | "browser_not_paired"
  | "browser_offline"
  | "browser_control_ended"
  | "invalid_request"
  | "action_failed"
  | "action_timeout";

export interface BrowserFailure {
  ok: false;
  status: 400 | 500;
  code: BrowserErrorCode;
  error: string;
}

export interface BrowserSuccess {
  ok: true;
  target?: string;
  tabs?: {
    target: string;
    scope: BrowserGrantScope;
    title: string;
    url: string;
  }[];
  /** The page's URL after the action. */
  url: string;
  /** The page's title after the action. */
  title: string;
  /** `snapshot` only: the ARIA tree, the same view a screen reader gets. */
  snapshot?: string;
  /** upload only: selected file metadata; no server path or bytes. */
  uploaded?: UploadedFile;
  /** `text` only: the rendered text of the page body. */
  text?: string;
  /** `screenshot` only: PNG bytes for the caller to turn into a chat card. */
  png?: Buffer;
  /** `screenshot` only: attachment name, query string stripped. */
  filename?: string;
  /** `screenshot` only: caption for the card - origin + pathname. */
  caption?: string;
  /** True when the action ended control. */
  closed?: boolean;
}

export type BrowserResult = BrowserSuccess | BrowserFailure;

function fail(
  status: 400 | 500,
  code: BrowserErrorCode,
  error: string,
): BrowserFailure {
  return { ok: false, status, code, error };
}

function invalid(error: string): BrowserFailure {
  return fail(400, "invalid_request", error);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describeShot(raw: string): {
  filename: string;
  caption: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { filename: "page.png", caption: "" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { filename: "page.png", caption: "" };
  const path = url.pathname === "/" ? "" : url.pathname;
  const slug =
    `${url.host}${path}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) ||
    "page";
  return { filename: `${slug}.png`, caption: `${url.origin}${path}` };
}

interface ParsedParams {
  ok: true;
  action: BrowserAction;
  target?: string;
  url?: URL;
  framePath?: number[];
  selector?: string;
  text?: string;
  path?: string;
  key?: string;
  fullPage?: boolean;
  viewport: { width: number; height: number };
}

export function validBrowserBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_DIM &&
    value <= MAX_DIM
  );
}

export function parseBrowserParams(
  body: unknown,
): ParsedParams | BrowserFailure {
  if (!isPlainObject(body)) return invalid("body must be a JSON object");
  const action = body.action;
  if (typeof action !== "string" || !isAction(action)) {
    return invalid(`action must be one of: ${BROWSER_ACTIONS.join(", ")}`);
  }

  const params: ParsedParams = {
    ok: true,
    action,
    viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
  };

  if (body.target !== undefined) {
    if (
      typeof body.target !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.target) ||
      action === "tabs"
    )
      return invalid(
        "target must be an offered target identifier on a page action",
      );
    params.target = body.target;
  }

  if (body.framePath !== undefined) {
    if (
      !["click", "fill", "press", "upload"].includes(action) ||
      !Array.isArray(body.framePath) ||
      body.framePath.length > MAX_FRAME_DEPTH ||
      body.framePath.some(
        (index) => !Number.isSafeInteger(index) || index < 0,
      ) ||
      (action === "press" && typeof body.selector !== "string")
    )
      return invalid(
        "framePath must be an array of up to 8 non-negative safe integers on an element action with a selector",
      );
    params.framePath = body.framePath;
  }

  if (body.viewport !== undefined) {
    if (!isPlainObject(body.viewport))
      return invalid("viewport must be an object {width, height}");
    const { width: w, height: h } = body.viewport;
    if (!validBrowserBound(w) || !validBrowserBound(h)) {
      return invalid(
        `viewport width/height must be integers in ${MIN_DIM}..${MAX_DIM}`,
      );
    }
    params.viewport = { width: w, height: h };
  }

  if (action === "goto") {
    const raw = body.url;
    if (typeof raw !== "string" || raw.length === 0)
      return invalid("url is required for the goto action");
    if (raw.length > MAX_URL_LEN)
      return invalid(`url too long (max ${MAX_URL_LEN} chars)`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid(`not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return invalid("only http:// and https:// URLs are supported");
    if (url.username || url.password)
      return invalid("URLs with embedded credentials are not allowed");
    params.url = url;
  }

  if (action === "click" || action === "fill" || action === "upload") {
    const selector = body.selector;
    if (typeof selector !== "string" || selector.length === 0)
      return invalid(`selector is required for the ${action} action`);
    if (selector.length > MAX_SELECTOR_LEN)
      return invalid(`selector too long (max ${MAX_SELECTOR_LEN} chars)`);
    params.selector = selector;
  }

  if (action === "upload") {
    if (!validUploadPath(body.path))
      return invalid(
        "path must be an absolute office-server file path (max 4096 characters)",
      );
    params.path = body.path;
  }

  if (action === "fill") {
    const text = body.text;
    if (typeof text !== "string")
      return invalid("text is required for the fill action");
    if (text.length > MAX_FILL_LEN)
      return invalid(`text too long (max ${MAX_FILL_LEN} chars)`);
    params.text = text;
  }

  if (action === "press") {
    const key = body.key;
    if (typeof key !== "string" || key.length === 0)
      return invalid("key is required for the press action");
    if (key.length > MAX_SELECTOR_LEN)
      return invalid(`key too long (max ${MAX_SELECTOR_LEN} chars)`);
    params.key = key;
    const selector = body.selector;
    if (selector !== undefined) {
      if (typeof selector !== "string" || selector.length === 0)
        return invalid("selector must be a non-empty string");
      if (selector.length > MAX_SELECTOR_LEN)
        return invalid(`selector too long (max ${MAX_SELECTOR_LEN} chars)`);
      params.selector = selector;
    }
  }

  if (action === "screenshot" && body.fullPage !== undefined) {
    if (typeof body.fullPage !== "boolean")
      return invalid("fullPage must be a boolean");
    params.fullPage = body.fullPage;
  }

  return params;
}

function isAction(value: string): value is BrowserAction {
  return (BROWSER_ACTIONS as readonly string[]).includes(value);
}
