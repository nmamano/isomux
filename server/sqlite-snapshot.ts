import { chmodSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function snapshotOfficeDatabase(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./sqlite-snapshot-child.ts", import.meta.url)), source, destination], { stdout: "ignore", stderr: "pipe" });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (timedOut || code !== 0) throw new Error(timedOut ? "SQLite snapshot timed out" : `SQLite snapshot failed: ${error}`);
    chmodSync(destination, 0o600);
  } catch (error) {
    try { unlinkSync(destination); } catch {}
    throw error;
  } finally { clearTimeout(timeout); }
}
