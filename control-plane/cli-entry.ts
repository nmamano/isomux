import { redactLogText, type Reporter } from "./report.ts";

/** A failed daemon must exit even when a server is still listening. */
export async function runCliEntry(
  main: () => Promise<void>,
  close: () => Promise<void>,
  reporter: Reporter,
  daemon: boolean,
): Promise<void> {
  if (!daemon) {
    try { await main(); } finally { await close(); }
    return;
  }
  let failed = false;
  const report = (error: unknown) => {
    failed = true;
    reporter.problem(redactLogText(error instanceof Error ? error.stack ?? error.message : String(error)));
  };
  try {
    await main();
  } catch (error) {
    report(error);
  }
  try {
    await close();
  } catch (error) {
    report(error);
  }
  if (failed) process.exit(1);
}
