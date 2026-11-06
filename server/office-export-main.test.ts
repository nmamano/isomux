// The owner export's child (task cdd7883d, slice 4): runExportChild packs the
// export (server/office-export.ts, which owns what goes in and the redaction)
// into one .tar.gz. This file owns the packing: a readable archive of the
// export, owner-only, no scratch folder left, and on failure one error line,
// exit 1 and no file.

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runExportChild } from "./office-export-main.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seed(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateRoot, "agents.json"),
    JSON.stringify([
      {
        id: "room-a",
        name: "Packed Room Seven",
        agents: [
          {
            id: "agent-one",
            name: "Agent One",
            desk: 0,
            cwd: "/srv/work",
            agentType: "claude",
            roomId: "room-a",
          },
        ],
      },
    ]),
  );
  writeFileSync(
    join(stateRoot, "users.json"),
    JSON.stringify({
      u1: { id: "u1", name: "Ann", role: "owner", allowedRooms: [] },
    }),
  );
}

test("the child packs the export into one owner-only .tar.gz and removes its folder", async () => {
  dir = mkdtempSync(join(tmpdir(), "office-export-main-"));
  const stateRoot = join(dir, ".isomux");
  seed(stateRoot);
  const exportsDir = join(dir, "isomux-backups", "exports");
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  const outFile = join(exportsDir, "office.tar.gz");

  const code = await runExportChild([stateRoot, outFile]);

  expect(code).toBe(0);
  expect(statSync(outFile).mode & 0o777).toBe(0o600);
  // Nothing next to it: the export folder it packed is gone.
  expect(readdirSync(exportsDir)).toEqual(["office.tar.gz"]);
  const list = spawnSync("tar", ["-tzf", outFile], { encoding: "utf8" });
  expect(list.status).toBe(0);
  // The room is in the export (office-export renders it); read it back from
  // the archive, not from the folder the child removed.
  const text = spawnSync("tar", ["-xzOf", outFile], { encoding: "utf8" });
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("Packed Room Seven");
});

test("a failed export exits 1 with one error line and leaves no file and no folder", async () => {
  dir = mkdtempSync(join(tmpdir(), "office-export-main-"));
  const stateRoot = join(dir, ".isomux");
  seed(stateRoot);
  // office-export refuses an output inside the state root.
  const outFile = join(stateRoot, "exports", "office.tar.gz");
  mkdirSync(join(stateRoot, "exports"), { mode: 0o700 });
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" ") + "\n");
  let code: number;
  try {
    code = await runExportChild([stateRoot, outFile]);
  } finally {
    process.stderr.write = write;
    console.error = origError;
  }

  expect(code).toBe(1);
  const lines = errors
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "");
  expect(lines).toHaveLength(1);
  expect(existsSync(outFile)).toBe(false);
  expect(readdirSync(join(stateRoot, "exports"))).toEqual([]);
});
