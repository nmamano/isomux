// The office serves the built UI through server/static-assets.ts: a signed-in
// browser gets a hashed chunk compressed and cached for a year, and revalidates
// every other file to a 304. The module's own cases are in
// server/static-assets.test.ts; this is the one wiring proof through the real
// office fetch.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { startTestServer, type TestServer } from "./harness.ts";

const DIST = join(import.meta.dir, "..", "..", "ui", "dist");
const chunk = existsSync(DIST)
  ? readdirSync(DIST).find((name) => /^[^/]+-[a-z0-9]{8}\.js$/.test(name))
  : undefined;
const builtUi = chunk !== undefined && existsSync(join(DIST, "xterm.css"));

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("office static files", () => {
  it.skipIf(!builtUi)(
    "a hashed chunk comes compressed and immutable, and xterm.css revalidates to a 304 (needs ui/dist - run `bun run build:ui`)",
    async () => {
      server = await startTestServer();
      const owner = await server.seedOwner("Morgan");
      const fetchAs = (path: string, headers: Record<string, string>) =>
        server!.http(path, {
          rawSessionId: owner.rawSessionId,
          headers,
          // Bun's fetch option: keep the body as sent, so the encoding shows.
          ...({ decompress: false } as RequestInit),
        });

      const js = await fetchAs(`/${chunk}`, { "Accept-Encoding": "gzip" });
      expect(js.status).toBe(200);
      expect(js.headers.get("content-encoding")).toBe("gzip");
      expect(js.headers.get("content-type") ?? "").toMatch(/javascript/);
      expect(js.headers.get("cache-control")).toContain("immutable");
      const onDisk = await Bun.file(join(DIST, chunk!)).bytes();
      expect(
        gunzipSync(new Uint8Array(await js.arrayBuffer())).equals(onDisk),
      ).toBe(true);

      const css = await fetchAs("/xterm.css", {});
      expect(css.status).toBe(200);
      await css.arrayBuffer();
      const etag = css.headers.get("etag");
      expect(etag).toBeTruthy();
      const again = await fetchAs("/xterm.css", { "If-None-Match": etag! });
      expect(again.status).toBe(304);
    },
  );
});
