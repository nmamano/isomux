import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DARWIN_ABI,
  parsePeerPid,
  parseProcBsdInfo,
  parseXucredUid,
  readDarwinPeerCredentials,
  readDarwinProcessHop,
} from "./darwin-libsystem.ts";
import { readProcessHop } from "./process-identity.ts";

const { PROC_BSDINFO_SIZE, XUCRED_SIZE } = DARWIN_ABI;

const onDarwin = process.platform === "darwin";

function bsdInfo(
  fields: Partial<{
    status: number;
    pid: number;
    ppid: number;
    seconds: bigint;
    microseconds: bigint;
  }> = {},
): Uint8Array {
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(4, fields.status ?? 2, true);
  view.setUint32(12, fields.pid ?? 4242, true);
  view.setUint32(16, fields.ppid ?? 77, true);
  view.setBigUint64(120, fields.seconds ?? 1_790_000_000n, true);
  view.setBigUint64(128, fields.microseconds ?? 5n, true);
  return buffer;
}

function xucred(version: number, uid: number): Uint8Array {
  const buffer = new Uint8Array(XUCRED_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, version, true);
  view.setUint32(4, uid, true);
  return buffer;
}

function int32(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setInt32(0, value, true);
  return buffer;
}

describe("macOS process info parsing", () => {
  it("reads the parent and a microsecond start identity", () => {
    expect(parseProcBsdInfo(bsdInfo(), PROC_BSDINFO_SIZE, 4242)).toEqual({
      pid: 4242,
      parentPid: 77,
      startTicks: "1790000000.000005",
    });
  });

  it("refuses short, failed, foreign, zombie and malformed results", () => {
    const valid = bsdInfo();
    for (const written of [0, -1, PROC_BSDINFO_SIZE - 1, PROC_BSDINFO_SIZE + 8])
      expect(parseProcBsdInfo(valid, written, 4242)).toBeNull();
    expect(
      parseProcBsdInfo(valid.subarray(0, 100), PROC_BSDINFO_SIZE, 4242),
    ).toBeNull();
    expect(parseProcBsdInfo(valid, PROC_BSDINFO_SIZE, 4243)).toBeNull();
    for (const fields of [
      { status: 5 },
      { seconds: 0n },
      { microseconds: 1_000_000n },
    ])
      expect(
        parseProcBsdInfo(bsdInfo(fields), PROC_BSDINFO_SIZE, 4242),
      ).toBeNull();
  });
});

describe("macOS peer credential parsing", () => {
  it("reads the uid of a version 0 xucred", () => {
    expect(parseXucredUid(xucred(0, 501), XUCRED_SIZE)).toBe(501);
  });

  it("refuses a short or unknown xucred", () => {
    expect(parseXucredUid(xucred(0, 501), XUCRED_SIZE - 4)).toBeNull();
    expect(parseXucredUid(xucred(0, 501), 0)).toBeNull();
    expect(
      parseXucredUid(xucred(0, 501).subarray(0, 8), XUCRED_SIZE),
    ).toBeNull();
    expect(parseXucredUid(xucred(1, 501), XUCRED_SIZE)).toBeNull();
  });

  it("reads a positive peer pid and refuses anything else", () => {
    expect(parsePeerPid(int32(4242), 4)).toBe(4242);
    expect(parsePeerPid(int32(4242), 2)).toBeNull();
    expect(parsePeerPid(int32(4242), 8)).toBeNull();
    expect(parsePeerPid(int32(0), 4)).toBeNull();
    expect(parsePeerPid(int32(-1), 4)).toBeNull();
  });
});

describe("macOS process calls", () => {
  it.skipIf(onDarwin)("read nothing off macOS", () => {
    expect(readDarwinProcessHop(process.pid)).toBeNull();
    expect(readDarwinPeerCredentials(0)).toBeNull();
  });

  it.skipIf(!onDarwin)("read this process, its parent and its start", () => {
    const hop = readDarwinProcessHop(process.pid);
    expect(hop?.parentPid).toBe(process.ppid);
    const started = Date.now() / 1000 - process.uptime();
    expect(Math.abs(Number(hop!.startTicks) - started)).toBeLessThan(2);
    expect(readProcessHop(process.pid)).toEqual(hop);
    expect(readDarwinProcessHop(process.ppid)?.pid).toBe(process.ppid);
  });

  it.skipIf(!onDarwin)("refuse an exited process", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(readDarwinProcessHop(child.pid)).toBeNull();
  });

  it.skipIf(!onDarwin)("refuse a process of another user", () => {
    // launchd (pid 1) belongs to root; PROC_PIDTBSDINFO is same-user only.
    expect(readDarwinProcessHop(1)).toBeNull();
  });
});

// DARWIN_ABI is hand-copied from the SDK headers. Compile against the
// installed SDK and compare, on each Mac architecture CI runs.
describe("macOS ABI", () => {
  it.skipIf(!onDarwin || !Bun.which("cc"))(
    "matches the SDK layout of proc_bsdinfo and xucred",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "isomux-darwin-abi-"));
      try {
        const source = join(dir, "abi.c");
        writeFileSync(
          source,
          `#include <stdio.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ucred.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/file.h>
#include <fcntl.h>
int main(void) {
  printf("PROC_PIDTBSDINFO=%d\\n", PROC_PIDTBSDINFO);
  printf("PROC_BSDINFO_SIZE=%zu\\n", sizeof(struct proc_bsdinfo));
  printf("PBI_STATUS=%zu\\n", offsetof(struct proc_bsdinfo, pbi_status));
  printf("PBI_PID=%zu\\n", offsetof(struct proc_bsdinfo, pbi_pid));
  printf("PBI_PPID=%zu\\n", offsetof(struct proc_bsdinfo, pbi_ppid));
  printf("PBI_START_TVSEC=%zu\\n", offsetof(struct proc_bsdinfo, pbi_start_tvsec));
  printf("PBI_START_TVUSEC=%zu\\n", offsetof(struct proc_bsdinfo, pbi_start_tvusec));
  printf("SZOMB=%d\\n", SZOMB);
  printf("XUCRED_SIZE=%zu\\n", sizeof(struct xucred));
  printf("XUCRED_CR_UID=%zu\\n", offsetof(struct xucred, cr_uid));
  printf("XUCRED_VERSION=%d\\n", XUCRED_VERSION);
  printf("PID_SIZE=%zu\\n", sizeof(pid_t));
  printf("SOL_LOCAL=%d\\n", SOL_LOCAL);
  printf("LOCAL_PEERCRED=%d\\n", LOCAL_PEERCRED);
  printf("LOCAL_PEERPID=%d\\n", LOCAL_PEERPID);
  printf("LOCK_EX=%d\\n", LOCK_EX);
  printf("O_CLOEXEC=%d\\n", O_CLOEXEC);
  return 0;
}
`,
        );
        const binary = join(dir, "abi");
        const compile = Bun.spawnSync(["cc", "-o", binary, source], {
          stderr: "pipe",
        });
        expect(compile.stderr.toString()).toBe("");
        const output = Bun.spawnSync([binary]).stdout.toString().trim();
        const sdk = Object.fromEntries(
          output.split("\n").map((line) => {
            const [name, value] = line.split("=");
            return [name, Number(value)];
          }),
        );
        expect(sdk).toEqual({ ...DARWIN_ABI });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
