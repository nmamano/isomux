// Run only by temp-root.test.ts, in a nested `bun test` whose TMPDIR is a
// scratch folder. The main suite does not collect it (no ".test." in the
// name). It records the temp folders the preload gave this run; with
// TEMP_ROOT_FIXTURE_HOLD set, it also starts a helper process the way the
// OpenCode supervisor tests do (inherited environment) and never finishes, so
// the parent can kill the run.
import { test } from "bun:test";
import { spawn } from "child_process";
import { renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";

test("records the run's temp folders", async () => {
  const hold = process.env.TEMP_ROOT_FIXTURE_HOLD === "1";
  const info: Record<string, unknown> = {
    pid: process.pid,
    tmpdir: tmpdir(),
    TMPDIR: process.env.TMPDIR,
    home: process.env.ISOMUX_HOME,
  };
  if (hold) {
    const helper = spawn("sleep", ["1000"], { stdio: "ignore" });
    helper.unref();
    info.helper = helper.pid;
  }
  const out = process.env.TEMP_ROOT_FIXTURE_OUT!;
  writeFileSync(`${out}.part`, JSON.stringify(info));
  renameSync(`${out}.part`, out);
  if (hold) await new Promise(() => {});
}, 120_000);
