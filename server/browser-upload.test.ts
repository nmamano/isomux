import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_BROWSER_UPLOAD_BYTES, readBrowserUpload } from "./browser-upload";
import { parseBrowserParams } from "./browser-actions";

test("upload schema requires one absolute path and a bounded selector", () => {
  for (const path of [undefined, [], ["/tmp/file"], "", "relative.png", "C:\\file.png", "/a\0b", "/".repeat(4097)])
    expect(parseBrowserParams({ action: "upload", selector: "#file", path })).toMatchObject({ ok: false, code: "invalid_request" });
  for (const selector of [undefined, "", "x".repeat(20_000)])
    expect(parseBrowserParams({ action: "upload", selector, path: "/tmp/file" })).toMatchObject({ ok: false, code: "invalid_request" });
  expect(parseBrowserParams({ action: "upload", selector: "#file", path: "/tmp/file" })).toMatchObject({ ok: true, action: "upload" });
});

test("file payload is bounded, binary-exact, named and typed without a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-"));
  try {
    const path = join(dir, "fixture\u202e.png");
    const bytes = Buffer.alloc(MAX_BROWSER_UPLOAD_BYTES, 0xa5);
    bytes[0] = 0; bytes[1] = 255;
    await writeFile(path, bytes);
    const file = await readBrowserUpload(path);
    expect(file).toEqual({ name: "fixture.png", mimeType: "image/png", buffer: bytes });
    await writeFile(path, Buffer.alloc(MAX_BROWSER_UPLOAD_BYTES + 1));
    expect(await readBrowserUpload(path).then(() => false, () => true)).toBe(true);
    const unknown = join(dir, "file.unknown-extension");
    await writeFile(unknown, "");
    expect(await readBrowserUpload(unknown)).toEqual({ name: "file.unknown-extension", mimeType: "application/octet-stream", buffer: Buffer.alloc(0) });
    expect(await readBrowserUpload(dir).then(() => false, () => true)).toBe(true);
    expect(await readBrowserUpload(join(dir, "missing")).then(() => false, () => true)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload rejects sensitive requested names and resolved symlink targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-upload-secret-"));
  try {
    await mkdir(join(dir, "codex-home"));
    for (const name of [".env", "private.key", "codex-home/auth.json", ".credentials.json"]) {
      const path = join(dir, name);
      await writeFile(path, "fixture only");
      expect(await readBrowserUpload(path).then(() => false, () => true)).toBe(true);
      const alias = join(dir, "alias-" + name.replaceAll("/", "-") + ".txt");
      await symlink(path, alias);
      expect(await readBrowserUpload(alias).then(() => false, () => true)).toBe(true);
    }
    const normal = join(dir, "ordinary.txt");
    await writeFile(normal, "fixture");
    const alias = join(dir, "sensitive.key");
    await symlink(normal, alias);
    expect(await readBrowserUpload(alias).then(() => false, () => true)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
