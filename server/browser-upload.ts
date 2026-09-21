import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { evaluateProposedAction } from "./safety-policy";

// Base64 plus the Playwright Runtime envelope must fit the 8 MiB bridge frame.
export const MAX_BROWSER_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD_PATH = 4096;
export class BrowserUploadError extends Error {}
export interface UploadedFile {
  name: string;
  mimeType: string;
  size: number;
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
export async function readBrowserUpload(path: string) {
  if (!validUploadPath(path))
    throw new BrowserUploadError(
      "path must be an absolute office-server file path (max 4096 characters)",
    );
  checkPath(normalize(path));
  try {
    const resolved = await realpath(path);
    checkPath(resolved);
    const file = await open(
      resolved,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new BrowserUploadError("path must name a regular file");
      if (stat.size > MAX_BROWSER_UPLOAD_BYTES)
        throw new BrowserUploadError("File exceeds the 4 MiB attachment limit");
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > stat.size || size > MAX_BROWSER_UPLOAD_BYTES)
        throw new BrowserUploadError(
          "File changed or exceeds the 4 MiB attachment limit",
        );
      const name =
        basename(path)
          .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/gu, "")
          .slice(0, 255) || "attachment";
      const mimeType = Bun.file(name).type || "application/octet-stream";
      return { name, mimeType, buffer: buffer.subarray(0, size) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof BrowserUploadError) throw error;
    throw new BrowserUploadError("File is unavailable or cannot be read");
  }
}
