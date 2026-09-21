import type { Frame } from "playwright-core";

export const MAX_FRAME_DEPTH = 8;
const MAX_READ_FRAMES = 64;

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
  collect(root, []);
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
      const remaining = Math.max(1, deadline - Date.now());
      const options = {
        timeout: path.length ? Math.min(1500, remaining) : remaining,
      };
      const body = frame.locator("body");
      append(
        action === "text"
          ? await body.innerText(options)
          : await body.ariaSnapshot(options),
      );
    } catch (error) {
      if (!path.length) throw error;
      append("[frame unavailable]");
    }
  }
  if (omitted) append("\n[additional frames omitted]");
  return output;
}
