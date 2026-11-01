// The helper's stop of an OpenCode server that runs in its own PID namespace
// (record.isolated; server/process-isolation.ts). The record pid is the outer
// bwrap, which has no --die-with-parent: the server outlives the helper that
// started it. A signal to the outer bwrap alone ends only bwrap. Skips where
// this host cannot make a PID namespace (checked directly).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readProcessStartTicks } from "./process-identity.ts";
import {
  bwrapMakesPidNamespace,
  killMarked,
  pidsWith,
  waitFor,
} from "../../test-support/process-markers.ts";

const pidNamespaces = bwrapMakesPidNamespace();

let dir: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-isolated-stop-"));
  marker = `iso-oc-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  killMarked(marker);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!pidNamespaces)(
  "OpenCode helper stop of an isolated server",
  () => {
    it("lets the server shut down, and returns only after its namespace is empty", async () => {
      // The server stand-in: it takes half a second to shut down on SIGTERM, as
      // 2.1.4 takes up to 1.14 s, and has a shell tool in its own process group.
      // The markers are in the scripts, not in bwrap's argv: the outer bwrap
      // and the namespace init carry argv in their command lines. The launcher
      // path names both of those.
      const server = join(dir, "server.sh");
      writeFileSync(
        server,
        `#!/bin/bash
trap 'sleep 0.5; echo graceful > ${dir}/graceful; exit 0' TERM
setsid bash -c 'exec -a ${marker}-tool sleep 300' &
sleep 300 & wait; wait`,
      );
      const launcher = join(dir, "launch-server.sh");
      writeFileSync(
        launcher,
        `#!/bin/bash\nexec -a ${marker}-server bash ${server}\n`,
      );
      chmodSync(launcher, 0o755);
      // The form the helper starts (bwrap as the record's pid, no
      // --die-with-parent), written out here so the fixture does not depend on
      // the code under test.
      const outer = spawn(
        "bwrap",
        ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", launcher],
        { stdio: "ignore", detached: true },
      );
      outer.unref();
      expect(await waitFor(() => pidsWith(`${marker}-tool`).length === 1)).toBe(
        true,
      );
      // The enabling condition: the outer bwrap and the init, by the launcher.
      expect(pidsWith(launcher)).toHaveLength(2);
      const startTicks = readProcessStartTicks(outer.pid!);
      expect(startTicks).not.toBeNull();

      const profileDir = join(dir, "profile");
      const recordPath = join(dir, "server.lock");
      writeFileSync(
        recordPath,
        JSON.stringify({
          pid: outer.pid,
          port: 1,
          password: "test-only",
          binary: "opencode",
          profileDir,
          environmentRevision: "test",
          configRevision: "test",
          startTicks,
          isolated: true,
        }),
      );
      const helper = Bun.spawn(
        [process.execPath, "run", join(import.meta.dir, "start-server.ts")],
        {
          env: {
            ...process.env,
            OPENCODE_SERVER_ACTION: "stop",
            OPENCODE_PROFILE_DIR: profileDir,
            OPENCODE_SERVER_RECORD: recordPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await helper.exited).toBe(0);

      // Checked at the helper's exit, with no wait: a replacement server can
      // start on the same profile at once.
      expect(pidsWith(`${marker}-server`)).toEqual([]);
      expect(pidsWith(`${marker}-tool`)).toEqual([]);
      // The init too: without --die-with-parent it outlives the outer bwrap
      // and keeps the namespace.
      expect(pidsWith(launcher)).toEqual([]);
      expect(existsSync(join(dir, "graceful"))).toBe(true);
    });
  },
);
