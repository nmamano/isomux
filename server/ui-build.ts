// The UI build id: a hash of the built bundle that scripts/build.sh stamps into
// the isomux-ui-build meta of ui/dist/index.html. The server tells tabs which
// build it serves (full_state, and a ui_build broadcast when a build:ui lands
// with no restart), and a tab running an older build shows a Reload notice
// (ui/components/UiBuildNotice.tsx).
//
// The id is a hash of the content, not of the time: Isomux Main and update.sh
// rebuild the UI when nothing in it changed, and those rebuilds must not tell
// every open tab to reload.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "../shared/types.ts";

const PLACEHOLDER = "__ISOMUX_UI_BUILD__";
const ID_RE = /^[0-9a-f]{16}$/;
const META_RE = /<meta name="isomux-ui-build" content="([^"]*)"/;

// The id in the isomux-ui-build meta of distDir's index.html. null when the
// page is missing, or its meta is absent or holds no valid id.
function readUiBuild(distDir: string): string | null {
  let html: string;
  try {
    html = readFileSync(join(distDir, "index.html"), "utf8");
  } catch {
    return null;
  }
  const id = META_RE.exec(html)?.[1] ?? "";
  return ID_RE.test(id) ? id : null;
}

// Called by scripts/build.sh on the stage dir, before scripts/publish-ui-dist.ts
// renames its files into ui/dist (index.html last). Hashes stageDir's index.js
// and its index.html (which still holds the placeholder meta) and puts the id
// in that meta. Returns the id. index.js names its chunks by their hashes, so
// its hash also covers them.
export function stampUiBuild(stageDir: string): string {
  const htmlPath = join(stageDir, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  // A page with no placeholder is stamped already: a new id for it would
  // never match the id the page carries, and the notice would never clear.
  if (!html.includes(PLACEHOLDER))
    throw new Error(`${htmlPath} has no ${PLACEHOLDER} placeholder`);
  const id = createHash("sha256")
    .update(readFileSync(join(stageDir, "index.js")))
    .update("\0")
    .update(html)
    .digest("hex")
    .slice(0, 16);
  writeFileSync(htmlPath, html.replace(PLACEHOLDER, id));
  return id;
}

export interface UiBuildTracker {
  current(): string | null;
  stop(): void;
}

function statSig(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

// Read the id now, then poll the file's stat (Bun's fs.watch misses a
// rename-replace, see server/file-editor.ts) and send one ui_build message
// each time the id changes.
export function trackUiBuild(
  distDir: string,
  send: (msg: ServerMessage) => void,
  opts?: { pollMs?: number },
): UiBuildTracker {
  const path = join(distDir, "index.html");
  let sig = statSig(path);
  let id = readUiBuild(distDir);
  const timer = setInterval(() => {
    const next = statSig(path);
    if (next === sig) return;
    sig = next;
    const nextId = readUiBuild(distDir);
    if (nextId === id) return;
    id = nextId;
    send({ type: "ui_build", uiBuild: id });
  }, opts?.pollMs ?? 3000);
  timer.unref();
  return {
    current: () => id,
    stop: () => clearInterval(timer),
  };
}
