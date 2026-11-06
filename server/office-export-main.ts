// The owner export's child process (task cdd7883d, slice 4):
//
//   bun server/office-export-main.ts <state root> <out file>
//
// Writes the export (server/office-export.ts) into a folder next to
// <out file>, packs it into <out file> (.tar.gz, 0600), and removes the
// folder. Exit 0 on success; otherwise one error line on stderr, with no
// secret value, and exit 1. Under server/, so the container image holds it.

import { chmodSync, closeSync, openSync, rmSync } from "node:fs";
import { exportOffice } from "./office-export.ts";
import { exportPartsDir } from "./office-export-jobs.ts";

export async function runExportChild(argv: string[]): Promise<number> {
  if (argv.length !== 2) {
    console.error("usage: office-export-main.ts <state root> <out file>");
    return 1;
  }
  const [stateRoot, outFile] = argv;
  const parts = exportPartsDir(outFile);
  let created = false;
  let packed = false;
  try {
    await exportOffice({ stateRoot, outDir: parts, now: new Date() });
    // Owner-only before tar writes a byte; tar keeps the mode of the file.
    closeSync(openSync(outFile, "wx", 0o600));
    created = true;
    const tar = Bun.spawn(["tar", "-czf", outFile, "-C", parts, "."], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      tar.exited,
      new Response(tar.stderr).text(),
    ]);
    if (code !== 0) {
      const last = stderr.trim().split("\n").pop() ?? "";
      throw new Error(`tar exited ${code}${last ? `: ${last}` : ""}`);
    }
    chmodSync(outFile, 0o600);
    packed = true;
    return 0;
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    console.error(`Export failed: ${message.replace(/\s*\n\s*/g, " ")}`);
    return 1;
  } finally {
    rmSync(parts, { recursive: true, force: true });
    if (created && !packed) rmSync(outFile, { force: true });
  }
}

if (import.meta.main) process.exit(await runExportChild(process.argv.slice(2)));
