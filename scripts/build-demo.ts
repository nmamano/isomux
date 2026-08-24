#!/usr/bin/env bun

import { copyFileSync, mkdirSync } from "node:fs";

const OUT_DIR = "site/demo";

mkdirSync(OUT_DIR, { recursive: true });

for (const entrypoint of ["ui/demo-entry.tsx", "ui/demo-app-entry.tsx"]) {
  const build = Bun.spawn({
    cmd: ["bun", "build", entrypoint, "--outdir", OUT_DIR, "--production"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

copyFileSync("ui/demo.html", `${OUT_DIR}/index.html`);
copyFileSync("ui/demo-app.html", `${OUT_DIR}/app.html`);
copyFileSync("node_modules/@xterm/xterm/css/xterm.css", `${OUT_DIR}/xterm.css`);
