// Extension → MIME type lookup, shared between /api/files response headers,
// emitAgentReadFile attachment inference, legacy log entries (loadLog), and
// the ?download header of the chat file routes. Active types (HTML, SVG, XML)
// are safe to name here because every file route serves them under
// untrustedFileHeaders (server/auth-middleware.ts).

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  xml: "text/xml",
  html: "text/html",
  css: "text/css",
  yaml: "text/yaml",
  yml: "text/yaml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
};

const DEFAULT_MIME = "application/octet-stream";

export function mimeTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_MIME;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? DEFAULT_MIME;
}

// Content-Type for an HTTP *response* serving a file. Same lookup as
// mimeTypeForFilename, but appends charset=utf-8 for text-based types so
// browsers (notably on Windows) don't fall back to a legacy codepage and
// render mojibake. Kept separate from mimeTypeForFilename because that value
// is also stored as attachment mediaType, which should stay charset-free.
export function httpContentTypeForFilename(filename: string): string {
  const mime = mimeTypeForFilename(filename);
  if (mime.startsWith("text/") || mime === "application/json") {
    return `${mime}; charset=utf-8`;
  }
  return mime;
}

// Content-Disposition for a file served with ?download=<name>: save it under
// the name the client asks for (chat attachments keep their original name only
// in the log entry). Control characters and path parts go; a name left empty,
// "." or ".." falls back to the server filename. filename= is a printable-ASCII
// fallback for old clients, filename* the exact UTF-8 name (RFC 6266).
function attachmentDisposition(
  requested: string,
  serverFilename: string,
): string {
  const stripped = requested
    // eslint-disable-next-line no-control-regex -- control chars are the point
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/.*[/\\]/, "");
  const name =
    stripped === "" || stripped === "." || stripped === ".."
      ? serverFilename
      : stripped;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ?download=<name> (the chat's download button): save under that name.
export function downloadHeader(
  query: URLSearchParams,
  serverFilename: string,
): Record<string, string> {
  const requested = query.get("download");
  if (requested === null) return {};
  return {
    "Content-Disposition": attachmentDisposition(requested, serverFilename),
  };
}
