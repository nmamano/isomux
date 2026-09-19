import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

export async function buildBrowserExtension(
  outdir = resolve("browser-extension/dist"),
): Promise<void> {
  mkdirSync(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve("browser-extension/background.ts")],
    outdir,
    target: "browser",
  });
  if (!result.success) throw new Error("Browser extension build failed");
  for (const file of ["manifest.json", "connection.html"])
    copyFileSync(resolve("browser-extension", file), resolve(outdir, file));
}
if (import.meta.main) await buildBrowserExtension();
