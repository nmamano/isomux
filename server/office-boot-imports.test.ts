// The office loads playwright-core only when an agent first uses the browser
// (task 3117486d). It used to load at module scope, which cost every office
// start and every test file that imports the office about 0.8 s.
//
// This runs in a fresh process on purpose: bun test shares one module cache
// across the files of a run, so an in-process probe sees whatever an earlier
// file loaded.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const OFFICE = `${import.meta.dir}/isomux-office.ts`;

test("importing the office does not load playwright-core", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "isomux-boot-imports-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `
          const loaded = (part) =>
            Object.keys(require.cache).some((key) => key.includes(part));
          const office = await import(${JSON.stringify(OFFICE)});
          const afterOffice = {
            started: typeof office.startServer === "function",
            session: loaded("/server/browser-extension-session.ts"),
            playwright: loaded("/playwright-core/"),
          };
          await import("playwright-core");
          console.log(JSON.stringify({
            ...afterOffice,
            probeSeesPlaywright: loaded("/playwright-core/"),
          }));
        `,
      ],
      {
        env: {
          ...process.env,
          HOME: stateDir,
          ISOMUX_HOME: stateDir,
          ISOMUX_BACKUP_DIR: stateDir,
          XDG_CONFIG_HOME: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exit, err: exit === 0 ? "" : err }).toEqual({ exit: 0, err: "" });
    expect(JSON.parse(out.trim())).toEqual({
      // The office graph still holds the module that drives the browser.
      started: true,
      session: true,
      playwright: false,
      // The probe is not blind: an explicit import shows up in the cache.
      probeSeesPlaywright: true,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 15_000);
