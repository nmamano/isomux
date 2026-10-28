import type { Frame, Locator } from "playwright-core";

/** A Playwright wait that had no timeout of its own and outlived its bound. */
export class StalledWaitError extends Error {
  override name = "TimeoutError";
}

/** Rejects with StalledWaitError when p has not settled after ms. p can
 * still reject later, when its client closes: that rejection is handled. */
export function withinDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StalledWaitError("The browser wait got no answer")),
        Math.max(1, ms),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export const MAX_FRAME_DEPTH = 8;
const MAX_READ_FRAMES = 64;
/** Replaces the value of a password field in a snapshot. */
export const PASSWORD_MASK = "[password masked]";
const CHILD_READ_MS = 1500;
/** How long a scoped read waits for its selector to match an element. */
export const SCOPED_READ_ATTACH_MS = 3000;
/** A scoped read whose selector matched no element within SCOPED_READ_ATTACH_MS. */
export class MissingSelectorError extends Error {}

// The marker names the class of failure only: an error message can carry
// page content.
function unreadFrame(frame: Frame, error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return "[frame not read: no answer in time; read it alone with framePath]";
  if (
    frame.isDetached() ||
    (error instanceof Error &&
      error.message.includes("Execution context was destroyed"))
  )
    return "[frame not read: it closed or navigated; read again]";
  return "[frame not read: the read failed]";
}

// Paths describe the current frame tree, not a persistent frame identity.
export function resolveBrowserFrame(root: Frame, path: number[]): Frame {
  let frame = root;
  for (const index of path) {
    const child = frame.childFrames()[index];
    if (!child || child.isDetached())
      throw new Error(
        "framePath is no longer available; read snapshot or text again",
      );
    frame = child;
  }
  return frame;
}

export async function readBrowserFrames(
  root: Frame,
  action: "text" | "snapshot",
  limit: number,
  timeout: number,
  scope?: { selector?: string; framePath?: number[] },
): Promise<string> {
  const entries: { frame: Frame; path: number[] }[] = [];
  let omitted = false;
  const collect = (frame: Frame, path: number[]) => {
    if (entries.length >= MAX_READ_FRAMES || path.length > MAX_FRAME_DEPTH) {
      omitted = true;
      return;
    }
    entries.push({ frame, path });
    frame
      .childFrames()
      .forEach((child, index) => collect(child, [...path, index]));
  };
  const scoped =
    scope?.selector !== undefined || scope?.framePath !== undefined;
  if (scoped)
    entries.push({
      frame: resolveBrowserFrame(root, scope.framePath ?? []),
      path: [],
    });
  else collect(root, []);
  const deadline = Date.now() + timeout;
  let output = "";
  const append = (part: string) => {
    const combined = output + part;
    const marker = "\n[truncated]";
    output =
      combined.length <= limit
        ? combined
        : combined.slice(0, Math.max(0, limit - marker.length)) +
          marker.slice(0, limit);
  };
  for (const { frame, path } of entries) {
    if (output.length >= limit) break;
    if (path.length)
      append(`\n\n--- Frame framePath=${JSON.stringify(path)} ---\n`);
    if (output.length >= limit) break;
    try {
      if (frame.isDetached()) throw new Error("Detached frame");
      const body = frame.locator(scope?.selector ?? "body");
      // A selector that matches nothing fails here, not at the deadline.
      // first(): a selector that matches more than once keeps the read's own
      // error.
      // A wait the action deadline cut short stays a deadline timeout.
      if (scope?.selector !== undefined) {
        const left = Math.max(1, deadline - Date.now());
        try {
          await body.first().waitFor({
            state: "attached",
            timeout: Math.min(SCOPED_READ_ATTACH_MS, left),
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.name === "TimeoutError" &&
            left > SCOPED_READ_ATTACH_MS
          )
            throw new MissingSelectorError("No element matches the selector");
          throw error;
        }
      }
      const remaining = Math.max(1, deadline - Date.now());
      const options = {
        timeout: path.length ? Math.min(CHILD_READ_MS, remaining) : remaining,
      };
      append(
        action === "text"
          ? await body.innerText(options)
          : await snapshotWithEditableText(
              frame,
              body,
              options.timeout,
              limit - output.length,
            ),
      );
    } catch (error) {
      if (!path.length) throw error;
      append(unreadFrame(frame, error));
    }
  }
  if (omitted) append("\n[additional frames omitted]");
  return output;
}

// Playwright omits contenteditable textbox children from the ARIA tree. Add
// only rendered values from visible, accessibility-present textboxes in scope.
async function snapshotWithEditableText(
  frame: Frame,
  scope: Locator,
  timeout: number,
  limit: number,
): Promise<string> {
  const deadline = Date.now() + timeout;
  const before = await readPasswordValues(frame, deadline);
  const snapshot = await scope.ariaSnapshot({
    timeout: Math.max(1, deadline - Date.now()),
  });
  const passwords = [...before, ...(await readPasswordValues(frame, deadline))];
  if (snapshot.length >= limit || Date.now() >= deadline)
    return maskPasswordValues(snapshot, passwords);
  // Public locator reads use Playwright's utility world. Page evaluation needs
  // a main-world context that may not be announced again when an All grant
  // changes clients without detaching Chrome's debugger.
  const boxes = scope
    .locator(":scope, :scope *")
    .and(frame.getByRole("textbox"))
    .and(frame.locator(":read-write:not(input):not(textarea)"))
    .filter({ visible: true });
  const values: string[] = [];
  let length = 0;
  // count() has no timeout of its own.
  const count = await withinDeadline(boxes.count(), deadline - Date.now());
  for (let index = 0; index < count && length < limit; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const value = (
      await boxes.nth(index).innerText({ timeout: remaining })
    ).trim();
    if (!value) continue;
    values.push(value.slice(0, limit));
    length += value.length;
  }
  const normalized = snapshot.replace(/\s+/g, " ");
  const missing = values.filter(
    (value) =>
      !normalized.includes(value.replace(/\s+/g, " ")) &&
      !snapshot.includes(JSON.stringify(value)),
  );
  return maskPasswordValues(
    missing.length
      ? snapshot +
          "\n\n--- Editable textbox text ---\n" +
          missing.map((value) => "- " + JSON.stringify(value)).join("\n")
      : snapshot,
    passwords,
  );
}

// Password values are read before and after the snapshot, so a value that
// autofill sets or a script clears while it runs is still masked. A value that
// exists only between the two reads (a person who types during the snapshot)
// is not. A read that fails or times out throws, so the caller withholds the
// frame instead of returning it unmasked.
const PASSWORD_READ_FLOOR_MS = 1000;

async function readPasswordValues(
  frame: Frame,
  deadline: number,
): Promise<string[]> {
  const passDeadline =
    Date.now() + Math.max(deadline - Date.now(), PASSWORD_READ_FLOOR_MS);
  const fields = frame.locator("input[type=password]");
  const count = await withinDeadline(fields.count(), passDeadline - Date.now());
  const values: string[] = [];
  for (let index = 0; index < count; index++)
    values.push(
      await fields
        .nth(index)
        .inputValue({ timeout: Math.max(1, passDeadline - Date.now()) }),
    );
  return values;
}

// The ARIA snapshot prints a password field's value as a textbox line value,
// and accessible-name rules can copy it into another node's name (a button
// labelled by the field). Mask a line that ends in the value, at any length,
// and every other occurrence of a value of 4 or more characters. A shorter
// value in another node's name stays: masking each "3" in the page text would
// destroy the read.
function maskPasswordValues(text: string, values: string[]): string {
  const normalized = [
    ...new Set(values.map(normalizeWhiteSpace).filter(Boolean)),
  ];
  if (!normalized.length) return text;
  const tails = normalized.flatMap((value) => [
    ": " + value,
    ": " + yamlQuote(value),
  ]);
  const masked = text
    .split("\n")
    .map((line) => {
      const tail = tails.find((candidate) => line.endsWith(candidate));
      return tail
        ? line.slice(0, line.length - tail.length) + ": " + PASSWORD_MASK
        : line;
    })
    .join("\n");
  const forms = [
    ...new Set(
      normalized
        .filter((value) => value.length >= 4)
        .flatMap((value) => {
          const name = JSON.stringify(value).slice(1, -1);
          return [value, name, name.replaceAll("'", "''")];
        }),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!forms.length) return masked;
  const pattern = new RegExp(
    forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  // Split on the mask so a value cannot match inside a mask already written.
  return masked
    .split(PASSWORD_MASK)
    .map((part) => part.replace(pattern, PASSWORD_MASK))
    .join(PASSWORD_MASK);
}

// Copies of Playwright's normalizeWhiteSpace and yamlEscapeValueIfNeeded
// quoting (1.62): the snapshot prints a textbox value in this form.
function normalizeWhiteSpace(text: string): string {
  return text
    .replace(/[\u200b\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function yamlQuote(text: string): string {
  return (
    '"' +
    // eslint-disable-next-line no-control-regex -- Playwright escapes them
    text.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => {
      switch (c) {
        case "\\":
          return "\\\\";
        case '"':
          return '\\"';
        case "\b":
          return "\\b";
        case "\f":
          return "\\f";
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default:
          return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
      }
    }) +
    '"'
  );
}
