import {
  mkdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { extensionZip } from "./extension-zip";

export const EXTENSION_ENTRIES = [
  "background.js",
  "connection.css",
  "connection.html",
  "connection.js",
  "manifest.json",
  "icon.png",
] as const;
export async function buildBrowserExtension(
  outdir = resolve("browser-extension/dist"),
): Promise<void> {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      resolve("browser-extension/background.ts"),
      resolve("browser-extension/connection.ts"),
    ],
    outdir,
    target: "browser",
  });
  if (!result.success) throw new Error("Browser extension build failed");
  for (const file of ["manifest.json", "connection.html", "connection.css"])
    copyFileSync(resolve("browser-extension", file), resolve(outdir, file));
  copyFileSync(resolve("ui/icons/icon-192.png"), resolve(outdir, "icon.png"));
  const archive = `${outdir}.zip`;
  const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      extensionZip(
        EXTENSION_ENTRIES.map((name) => ({
          name,
          data: readFileSync(resolve(outdir, name)),
        })),
      ),
    );
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
}
if (import.meta.main) await buildBrowserExtension();
