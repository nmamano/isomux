// server/update-conf.ts - the server-side reader for the updater root-of-trust
// config. Pure file parsing over temp fixtures; the strict consumer contract
// lives with scripts/update.sh (scripts/update-sh.test.ts). The load-bearing
// distinction, absent vs. invalid (presence alone makes a box updater-managed,
// even when the file is damaged), is pinned where it decides something: the
// trigger refusals in update-trigger.test.ts. Zero LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readUpdateConf } from "./update-conf.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isomux-update-conf-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(content: string): string {
  const p = join(dir, "update.conf");
  writeFileSync(p, content);
  return p;
}

describe("readUpdateConf", () => {
  it("parses key=value lines, skipping comments and blanks", () => {
    const p = write(
      "# Written by the isomux installer\n" +
        "REPO_DIR=/opt/isomux\n" +
        "REPO_URL=https://github.com/nmamano/isomux.git\n" +
        "\n" +
        "SERVICE_KIND=system\n" +
        "UPDATER_PATH=/usr/local/sbin/isomux-update\n" +
        // Forward compat: update.sh is the strict reader, the server keeps
        // the keys it knows.
        "FUTURE_KEY=1\n",
    );
    expect(readUpdateConf(p)).toEqual({
      state: "parsed",
      values: {
        REPO_DIR: "/opt/isomux",
        REPO_URL: "https://github.com/nmamano/isomux.git",
        SERVICE_KIND: "system",
        UPDATER_PATH: "/usr/local/sbin/isomux-update",
        FUTURE_KEY: "1",
      },
    });
  });

  it("keeps values literal - '=' in the value, shell metachars stay data", () => {
    const conf = readUpdateConf(write("REPO_URL=x=y;$(reboot)\n"));
    expect(conf.state).toBe("parsed");
    if (conf.state === "parsed") {
      expect(conf.values.REPO_URL).toBe("x=y;$(reboot)");
    }
  });
});
