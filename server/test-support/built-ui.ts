// A fresh checkout or worktree has no ui/dist until build:ui runs, so tests
// use these gates to skip only assertions that need built files. Check the
// exact files each test reads: an interrupted build can leave the directory
// behind. There is no override because it could make a green run meaningless.

import { existsSync } from "node:fs";

const builtFileExists = (path: string): boolean =>
  existsSync(new URL(`../../ui/dist/${path}`, import.meta.url));

export const builtShellExists = builtFileExists("index.html");

export const builtPwaAssetsExist = [
  "manifest.json",
  "icons/icon-192.png",
].every(builtFileExists);
