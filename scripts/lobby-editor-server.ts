#!/usr/bin/env bun
// Serves the lobby layout editor (ui/office/lobby/LobbyEditor.tsx via the
// preview entry with ?edit=1) and saves exported layouts on the box. A one-off
// tool for laying out the lobby, registered as an isomux app so Nil can reach
// it from any device. GET /rebuild rebuilds the bundle after code changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// Where the bundle is built and where saved layouts live. Both are settable,
// so this tool is not tied to one machine's paths: LOBBY_EDITOR_SAVE_DIR wins,
// then the data directory isomux hands a registered app, then a local folder.
const OUT = process.env.LOBBY_EDITOR_OUT_DIR ?? "/tmp/lobby-editor";
const SAVE_DIR =
  process.env.LOBBY_EDITOR_SAVE_DIR ?? process.env.ISOMUX_APP_DATA_DIR ?? join(OUT, "saved");
mkdirSync(OUT, { recursive: true });
mkdirSync(SAVE_DIR, { recursive: true });

function build(): string {
  const r = Bun.spawnSync({
    cmd: ["bun", "build", "ui/office/lobby/preview-entry.tsx", "--outdir", OUT, "--production"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  writeFileSync(
    join(OUT, "preview.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Lobby editor</title></head><body><div id="root"></div><script type="module" src="/preview-entry.js"></script></body></html>`,
  );
  return r.exitCode === 0 ? "built" : `build failed:\n${r.stderr.toString()}`;
}
console.log(build());

Bun.serve({
  port: Number(process.env.PORT ?? 9879),
  hostname: process.env.ISOMUX_APP_HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return Response.redirect("/preview.html?edit=1&layout=fireside&mode=light", 302);
    if (url.pathname === "/rebuild") return new Response(build(), { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/save" && req.method === "POST") {
      const body = (await req.json()) as { name?: string };
      const name = String(body.name ?? "layout").replace(/[^a-z0-9_-]/gi, "_");
      const path = join(SAVE_DIR, `${name}.json`);
      writeFileSync(path, JSON.stringify(body, null, 2));
      return Response.json({ ok: true, path });
    }
    if (url.pathname === "/saved") {
      const names = [...new Bun.Glob("*.json").scanSync(SAVE_DIR)].map((f) => f.replace(/\.json$/, "")).sort();
      return Response.json(names);
    }
    if (url.pathname.startsWith("/saved/")) {
      const name = decodeURIComponent(url.pathname.slice("/saved/".length)).replace(/[^a-z0-9_-]/gi, "_");
      const saved = Bun.file(join(SAVE_DIR, `${name}.json`));
      if (!(await saved.exists())) return Response.json({ error: "not found", name }, { status: 404 });
      return new Response(saved, { headers: { "content-type": "application/json" } });
    }
    const file = Bun.file(join(OUT, url.pathname.replace(/^\/+/, "")));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});
console.log(`lobby editor on ${process.env.ISOMUX_APP_HOST ?? "default host"}:${process.env.PORT ?? 9879}, saves in ${SAVE_DIR}`);
