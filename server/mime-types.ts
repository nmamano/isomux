// Extension → MIME type lookup, shared between /api/files response headers
// and emitAgentReadFile attachment inference. SVG is intentionally omitted:
// it falls through to octet-stream so we don't advertise SVG as inline image
// content. (The /api/files response doesn't set nosniff, so browsers may
// still sniff — if we want the stronger guarantee later, add the header.)

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  xml: "text/xml",
  html: "text/html",
  css: "text/css",
};

const DEFAULT_MIME = "application/octet-stream";

export function mimeTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_MIME;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? DEFAULT_MIME;
}
