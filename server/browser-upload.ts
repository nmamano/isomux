import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { evaluateProposedAction } from "./safety-policy";

// A sanity cap. The deadline it gives (browserUploadExtraMs) must stay under
// the front door's idle timeout.
export const MAX_BROWSER_UPLOAD_BYTES = 100 * 1024 * 1024;
// One chunk's base64 plus the Playwright Runtime envelope must fit the 8 MiB
// extension frame.
export const BROWSER_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_BROWSER_UPLOAD_PATH = 4096;
export class BrowserUploadError extends Error {}
export interface UploadedFile {
  name: string;
  mimeType: string;
  size: number;
}
export interface BrowserUpload {
  name: string;
  mimeType: string;
  size: number;
  /** The file's bytes in order, each piece at most BROWSER_UPLOAD_CHUNK_BYTES. */
  chunks(): AsyncIterable<Uint8Array<ArrayBuffer>>;
  close(): Promise<void>;
}
const MiB = 1024 * 1024;
// The time per started MiB: the upload needs about 1.7 MiB/s of file bytes to
// the browser (2.2 MiB/s of base64 on the wire).
const UPLOAD_MS_PER_MIB = 600;
const LIMIT_ERROR = `File exceeds the ${MAX_BROWSER_UPLOAD_BYTES / MiB} MiB attachment limit`;
/** The time an upload of size bytes adds to the action deadline. */
export function browserUploadExtraMs(size: number): number {
  return Math.ceil(size / MiB) * UPLOAD_MS_PER_MIB;
}
export function validUploadPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= MAX_BROWSER_UPLOAD_PATH &&
    isAbsolute(path) &&
    !path.includes("\0")
  );
}
function checkPath(path: string): void {
  if (
    evaluateProposedAction({
      kind: "read-files",
      toolName: "Read",
      input: { file_path: path },
    }).decision === "deny"
  )
    throw new BrowserUploadError("Sensitive files cannot be attached");
}
// Opens one server file for a browser upload. The caller closes it. chunks()
// reads the open descriptor in order and fails when the file no longer has
// the size it had at the open.
export async function openBrowserUpload(path: string): Promise<BrowserUpload> {
  if (!validUploadPath(path))
    throw new BrowserUploadError(
      "path must be an absolute office-server file path (max 4096 characters)",
    );
  checkPath(normalize(path));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const resolved = await realpath(path);
    checkPath(resolved);
    file = await open(
      resolved,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (!stat.isFile())
      throw new BrowserUploadError("path must name a regular file");
    if (stat.size > MAX_BROWSER_UPLOAD_BYTES)
      throw new BrowserUploadError(LIMIT_ERROR);
    const name =
      basename(path)
        .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/gu, "")
        .slice(0, 255) || "attachment";
    const opened = file;
    const size = stat.size;
    return {
      name,
      mimeType: Bun.file(name).type || "application/octet-stream",
      size,
      async *chunks() {
        let position = 0;
        while (position < size) {
          // A new array per piece, since the caller may keep each one. A
          // plain Uint8Array: Playwright sends a Buffer argument as an
          // object, not as bytes.
          const piece = new Uint8Array(
            Math.min(BROWSER_UPLOAD_CHUNK_BYTES, size - position),
          );
          let filled = 0;
          while (filled < piece.length) {
            const read = await readAt(opened, piece, filled, position + filled);
            if (!read) throw new BrowserUploadError(CHANGED_ERROR);
            filled += read;
          }
          position += filled;
          yield piece;
        }
        // One byte past the size: a file that grew is refused too.
        if (await readAt(opened, new Uint8Array(1), 0, size))
          throw new BrowserUploadError(CHANGED_ERROR);
      },
      close: () => opened.close(),
    };
  } catch (error) {
    await file?.close().catch(() => {});
    if (error instanceof BrowserUploadError) throw error;
    throw new BrowserUploadError("File is unavailable or cannot be read");
  }
}
const CHANGED_ERROR = "File changed while it was read";
async function readAt(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Uint8Array,
  offset: number,
  position: number,
): Promise<number> {
  try {
    return (await file.read(buffer, offset, buffer.length - offset, position))
      .bytesRead;
  } catch {
    throw new BrowserUploadError("File is unavailable or cannot be read");
  }
}

// The page side of an upload. Playwright sends each function's source, so
// none of them may use a name from this module.
export interface FileInputSink {
  input: HTMLInputElement;
  parts: Uint8Array<ArrayBuffer>[];
}
/**
 * Runs in the page on the selected element: the file input it names (a
 * label's control too), with an empty list for the file's chunks.
 */
export function fileInputSink(element: Element): FileInputSink {
  const input =
    element instanceof HTMLInputElement
      ? element
      : element.closest("label")?.control;
  if (!(input instanceof HTMLInputElement) || input.type !== "file")
    throw new Error("Not an input[type=file] element");
  if (input.webkitdirectory)
    throw new Error("A directory input takes no single file");
  return { input, parts: [] };
}
/** Runs in the page: keeps one chunk of the file. */
export function addFileChunk(
  sink: FileInputSink,
  chunk: Uint8Array<ArrayBuffer>,
): void {
  sink.parts.push(chunk);
}
/**
 * Runs in the page: sets the input's file from the chunks and fires the input
 * and change events a member's choice fires. Changes nothing and returns false
 * when the chunks do not make the whole file.
 */
export function setSinkFile(
  sink: FileInputSink,
  meta: { name: string; mimeType: string; size: number },
): boolean {
  const file = new File(sink.parts, meta.name, { type: meta.mimeType });
  sink.parts = [];
  if (file.size !== meta.size || !sink.input.isConnected) return false;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  sink.input.files = transfer.files;
  sink.input.dispatchEvent(
    new Event("input", { bubbles: true, composed: true }),
  );
  sink.input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
