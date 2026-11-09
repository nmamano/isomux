import { test, expect } from "bun:test";
import {
  appendFile,
  mkdtemp,
  rm,
  writeFile,
  symlink,
  mkdir,
  truncate,
} from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BROWSER_UPLOAD_CHUNK_BYTES,
  BrowserUploadError,
  MAX_BROWSER_UPLOAD_BYTES,
  browserUploadExtraMs,
  openBrowserUpload,
  type BrowserUpload,
} from "./browser-upload";
import {
  BROWSER_ACTION_DEADLINE_MS,
  parseBrowserParams,
} from "./browser-actions";
import { EXTENSION_MAX_BYTES } from "../shared/browser-extension-protocol";
import { OFFICE_IDLE_TIMEOUT_SECONDS } from "./office-front-door";

const MiB = 1024 * 1024;
// The process's open descriptors: an upload holds one from open to close.
const openFds = () => readdirSync("/proc/self/fd").length;
// Keeps every piece: a reader that reuses one buffer shows up as wrong bytes.
async function pieces(upload: BrowserUpload): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const piece of upload.chunks()) out.push(piece);
  return out;
}
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

test("upload schema requires one absolute path and a bounded selector", () => {
  for (const path of [
    undefined,
    [],
    ["/tmp/file"],
    "",
    "relative.png",
    "C:\\file.png",
    "/a\0b",
    "/".repeat(4097),
  ])
    expect(
      parseBrowserParams({ action: "upload", selector: "#file", path }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
  for (const selector of [undefined, "", "x".repeat(20_000)])
    expect(
      parseBrowserParams({ action: "upload", selector, path: "/tmp/file" }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
  expect(
    parseBrowserParams({
      action: "upload",
      selector: "#file",
      path: "/tmp/file",
    }),
  ).toMatchObject({ ok: true, action: "upload" });
});

test("chunks give the file byte-exact in pieces that fit one extension frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-"));
  try {
    const path = join(dir, "fixture\u202e.png");
    // Not a multiple of the chunk size, and every byte value.
    const bytes = Buffer.alloc(2 * BROWSER_UPLOAD_CHUNK_BYTES + 12_345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 16)) % 256;
    await writeFile(path, bytes);
    const before = openFds();
    const upload = await openBrowserUpload(path);
    try {
      expect({
        name: upload.name,
        mimeType: upload.mimeType,
        size: upload.size,
      }).toEqual({
        name: "fixture.png",
        mimeType: "image/png",
        size: bytes.length,
      });
      const got = await pieces(upload);
      expect(got.length).toBeGreaterThan(1);
      for (const piece of got) {
        expect(piece.length).toBeGreaterThan(0);
        expect(piece.length).toBeLessThanOrEqual(BROWSER_UPLOAD_CHUNK_BYTES);
      }
      expect(Buffer.concat(got).equals(bytes)).toBe(true);
    } finally {
      await upload.close();
    }
    expect(openFds()).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the chunk size fits one extension frame as base64 with room to spare", () => {
  // Playwright sends a typed-array argument as base64 in one Runtime command.
  const base64 = Math.ceil(BROWSER_UPLOAD_CHUNK_BYTES / 3) * 4;
  expect(base64).toBeLessThanOrEqual(EXTENSION_MAX_BYTES / 2);
  expect(MAX_BROWSER_UPLOAD_BYTES).toBeGreaterThanOrEqual(100 * MiB);
});

test("the size cap is checked on open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-cap-"));
  try {
    // Sparse files: no 100 MiB write.
    const atCap = join(dir, "at-cap.mp4");
    await writeFile(atCap, "");
    await truncate(atCap, MAX_BROWSER_UPLOAD_BYTES);
    const upload = await openBrowserUpload(atCap);
    expect(upload.size).toBe(MAX_BROWSER_UPLOAD_BYTES);
    expect(upload.mimeType).toBe("video/mp4");
    await upload.close();
    const over = join(dir, "over.mp4");
    await writeFile(over, "");
    await truncate(over, MAX_BROWSER_UPLOAD_BYTES + 1);
    const before = openFds();
    expect(await refused(openBrowserUpload(over))).toBeInstanceOf(
      BrowserUploadError,
    );
    // A refused open leaves no descriptor behind.
    expect(openFds()).toBe(before);
    const empty = join(dir, "file.unknown-extension");
    await writeFile(empty, "");
    const none = await openBrowserUpload(empty);
    expect({
      name: none.name,
      mimeType: none.mimeType,
      size: none.size,
    }).toEqual({
      name: "file.unknown-extension",
      mimeType: "application/octet-stream",
      size: 0,
    });
    expect(Buffer.concat(await pieces(none)).length).toBe(0);
    await none.close();
    expect(await refused(openBrowserUpload(dir))).toBeInstanceOf(
      BrowserUploadError,
    );
    expect(
      await refused(openBrowserUpload(join(dir, "missing"))),
    ).toBeInstanceOf(BrowserUploadError);
    expect(openFds()).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file that grows or shrinks after open fails the read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-change-"));
  try {
    const size = 2 * BROWSER_UPLOAD_CHUNK_BYTES;
    for (const change of ["grow", "shrink"] as const) {
      const path = join(dir, `${change}.bin`);
      await writeFile(path, Buffer.alloc(size, 0x5a));
      const upload = await openBrowserUpload(path);
      try {
        expect(upload.size).toBe(size);
        if (change === "grow") await appendFile(path, "x");
        else await truncate(path, size - 1);
        expect({ change, error: await refused(pieces(upload)) }).toEqual({
          change,
          error: expect.any(BrowserUploadError),
        });
      } finally {
        await upload.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload time grows with size and the largest upload answers before the idle cut", () => {
  expect(browserUploadExtraMs(0)).toBe(0);
  let last = 0;
  for (let size = 1; size <= MAX_BROWSER_UPLOAD_BYTES; size += MiB / 2) {
    const extra = browserUploadExtraMs(size);
    expect(extra).toBeGreaterThanOrEqual(last);
    last = extra;
  }
  // The budget assumes no more than 2 MiB/s of file bytes to the browser.
  for (const size of [MiB, 10 * MiB, MAX_BROWSER_UPLOAD_BYTES])
    expect(browserUploadExtraMs(size)).toBeGreaterThanOrEqual(
      (size / MiB) * 500,
    );
  // The answer comes at most two settlement graces (2 s) after the deadline;
  // the front door cuts a response that is idle for its timeout.
  expect(
    BROWSER_ACTION_DEADLINE_MS +
      browserUploadExtraMs(MAX_BROWSER_UPLOAD_BYTES) +
      15_000,
  ).toBeLessThanOrEqual(OFFICE_IDLE_TIMEOUT_SECONDS * 1000);
});

test("upload rejects sensitive requested names and resolved symlink targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-secret-"));
  try {
    await mkdir(join(dir, "codex-home"));
    const rejected = async (path: string) =>
      await refused(
        openBrowserUpload(path).then(async (opened) => {
          await opened.close();
          return opened;
        }),
      );
    for (const name of [
      ".env",
      "private.key",
      "codex-home/auth.json",
      ".credentials.json",
    ]) {
      const path = join(dir, name);
      await writeFile(path, "fixture only");
      expect({ name, error: await rejected(path) }).toEqual({
        name,
        error: expect.any(BrowserUploadError),
      });
      const alias = join(dir, "alias-" + name.replaceAll("/", "-") + ".txt");
      await symlink(path, alias);
      expect({ alias, error: await rejected(alias) }).toEqual({
        alias,
        error: expect.any(BrowserUploadError),
      });
    }
    const normal = join(dir, "ordinary.txt");
    await writeFile(normal, "fixture");
    const alias = join(dir, "sensitive.key");
    await symlink(normal, alias);
    expect(await rejected(alias)).toBeInstanceOf(BrowserUploadError);
    // The control: the same ordinary file under its own name opens.
    const ok = await openBrowserUpload(normal);
    expect(ok.size).toBe(7);
    await ok.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
