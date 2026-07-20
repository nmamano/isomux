// server/update-conf.ts — the server-side reader for the updater root-of-trust
// config. Pure file parsing over temp fixtures; the strict consumer contract
// lives with scripts/update.sh (scripts/update-sh.test.ts). The load-bearing
// distinction here is absent vs. invalid: presence alone makes a box
// updater-managed, even when the file is damaged. Zero LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readUpdateConf,
  updateConfPath,
  DEFAULT_UPDATE_CONF,
} from "./update-conf.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isomux-update-conf-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ISOMUX_UPDATE_CONF;
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
        "UPDATER_PATH=/usr/local/sbin/isomux-update\n",
    );
    const conf = readUpdateConf(p);
    expect(conf.state).toBe("parsed");
    if (conf.state !== "parsed") return;
    expect(conf.values.REPO_URL).toBe("https://github.com/nmamano/isomux.git");
    expect(conf.values.SERVICE_KIND).toBe("system");
    expect(conf.values.UPDATER_PATH).toBe("/usr/local/sbin/isomux-update");
  });

  it("keeps values literal — '=' in the value, shell metachars stay data", () => {
    const conf = readUpdateConf(write("REPO_URL=x=y;$(reboot)\n"));
    expect(conf.state).toBe("parsed");
    if (conf.state === "parsed") {
      expect(conf.values.REPO_URL).toBe("x=y;$(reboot)");
    }
  });

  it("tolerates unknown keys (forward compat; update.sh is the strict reader)", () => {
    const conf = readUpdateConf(write("SERVICE_KIND=user\nFUTURE_KEY=1\n"));
    expect(conf.state).toBe("parsed");
    if (conf.state === "parsed") {
      expect(conf.values.SERVICE_KIND).toBe("user");
      expect(conf.values.FUTURE_KEY).toBe("1");
    }
  });

  it("missing file -> absent (the not-updater-managed signal)", () => {
    expect(readUpdateConf(join(dir, "nope.conf"))).toEqual({
      state: "absent",
    });
  });

  it("malformed line (no '=') -> invalid, NOT absent: the box stays managed", () => {
    expect(readUpdateConf(write("SERVICE_KIND=user\ngarbage\n"))).toEqual({
      state: "invalid",
    });
  });
});

describe("updateConfPath", () => {
  it("defaults to /etc/isomux/update.conf; ISOMUX_UPDATE_CONF overrides", () => {
    delete process.env.ISOMUX_UPDATE_CONF;
    expect(updateConfPath()).toBe(DEFAULT_UPDATE_CONF);
    process.env.ISOMUX_UPDATE_CONF = "/tmp/x.conf";
    expect(updateConfPath()).toBe("/tmp/x.conf");
  });
});
