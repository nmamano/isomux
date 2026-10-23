// Reads the Content-Disposition of a chat file served with ?download=<name>,
// for the download tests in routes-uploads-rest.test.ts and
// routes-members-chat-rest.test.ts. It parses the header the way a browser
// does (RFC 6266: filename* wins, filename is the fallback), independently
// of the server helper that writes it.

import { expect } from "bun:test";

export interface AttachmentHeader {
  type: string;
  // filename* decoded from RFC 5987 UTF-8 percent-encoding.
  name: string;
  // The quoted filename= fallback for clients without filename*.
  fallback: string;
}

export function readAttachmentHeader(res: Response): AttachmentHeader {
  const header = res.headers.get("content-disposition");
  expect(header).not.toBeNull();
  const value = header!;
  expect(value).not.toMatch(/[\r\n]/);
  // type *( ";" name "=" ( token / quoted-string ) ), consumed to the end, so
  // a raw quote inside the fallback breaks the parse instead of cutting the
  // value short.
  const typeMatch = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(value);
  expect(typeMatch).not.toBeNull();
  const params = new Map<string, string>();
  const param =
    /^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))/;
  let rest = value.slice(typeMatch![0].length);
  while (rest.trim() !== "") {
    const m = param.exec(rest);
    expect(m === null ? `unparsed: ${rest}` : "parsed").toBe("parsed");
    params.set(
      m![1].toLowerCase(),
      m![2] !== undefined ? m![2].replace(/\\(.)/g, "$1") : m![3],
    );
    rest = rest.slice(m![0].length);
  }
  const star = params.get("filename*");
  const quoted = params.get("filename");
  expect(star).toStartWith("UTF-8''");
  expect(quoted).toBeDefined();
  return {
    type: typeMatch![1].toLowerCase(),
    name: decodeURIComponent(star!.slice("UTF-8''".length)),
    fallback: quoted!,
  };
}

// The fallback must be safe for any client: printable ASCII, with no quote or
// backslash that a parser could read as the end of the quoted string.
export function expectSafeFallback(fallback: string): void {
  expect(fallback.length).toBeGreaterThan(0);
  expect(fallback).toMatch(/^[\x20-\x7e]+$/);
  expect(fallback).not.toMatch(/["\\]/);
}

// Requested name -> the name the browser must save. Path parts (both
// separators) and control characters go; a name that is then empty, "." or
// ".." falls back to the server filename (null here).
export const DOWNLOAD_NAME_CASES: {
  requested: string;
  saved: string | null;
}[] = [
  { requested: "Résumé 截图.png", saved: "Résumé 截图.png" },
  { requested: 'say "hi".txt', saved: 'say "hi".txt' },
  { requested: "100% done; ok.txt", saved: "100% done; ok.txt" },
  {
    requested: "evil\r\nSet-Cookie: x=1.txt",
    saved: "evilSet-Cookie: x=1.txt",
  },
  { requested: "tab\there\u0000\u007f.txt", saved: "tabhere.txt" },
  { requested: "../../etc/passwd", saved: "passwd" },
  { requested: "C:\\Users\\me\\notes.txt", saved: "notes.txt" },
  { requested: "", saved: null },
  { requested: "..", saved: null },
  { requested: "dir/.", saved: null },
  { requested: "\u0000\u0001", saved: null },
];
