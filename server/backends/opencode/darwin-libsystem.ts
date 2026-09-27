import { dlopen, ptr } from "bun:ffi";
import { constants, openSync } from "node:fs";

// macOS calls behind the OpenCode authority broker and supervisor. Each reader
// returns null when a call fails or its result has an unexpected shape, and
// callers refuse on null. The parsers are separate from the calls so tests on
// any host can feed them short or malformed results.

export interface DarwinProcessHop {
  pid: number;
  parentPid: number;
  startTicks: string;
}

// Hand-copied from the SDK headers; darwin-libsystem.test.ts compiles against
// the installed SDK and compares. struct proc_bsdinfo (sys/proc_info.h) and
// struct xucred (sys/ucred.h) are the same on arm64 and x86_64.
export const DARWIN_ABI = {
  PROC_PIDTBSDINFO: 3,
  PROC_BSDINFO_SIZE: 136,
  PBI_STATUS: 4,
  PBI_PID: 12,
  PBI_PPID: 16,
  PBI_START_TVSEC: 120,
  PBI_START_TVUSEC: 128,
  SZOMB: 5,
  XUCRED_SIZE: 76,
  XUCRED_CR_UID: 4,
  XUCRED_VERSION: 0,
  PID_SIZE: 4,
  SOL_LOCAL: 0,
  LOCAL_PEERCRED: 1,
  LOCAL_PEERPID: 2,
  LOCK_EX: 2,
  // Node's fs.constants has no O_CLOEXEC; Bun passes the bit through.
  O_CLOEXEC: 0x01000000,
} as const;
const {
  PROC_PIDTBSDINFO,
  PROC_BSDINFO_SIZE,
  PBI_STATUS,
  PBI_PID,
  PBI_PPID,
  PBI_START_TVSEC,
  PBI_START_TVUSEC,
  SZOMB,
  XUCRED_SIZE,
  XUCRED_CR_UID,
  XUCRED_VERSION,
  PID_SIZE,
  SOL_LOCAL,
  LOCAL_PEERCRED,
  LOCAL_PEERPID,
  LOCK_EX,
  O_CLOEXEC,
} = DARWIN_ABI;

export function parseProcBsdInfo(
  buffer: Uint8Array,
  written: number,
  pid: number,
): DarwinProcessHop | null {
  if (written !== PROC_BSDINFO_SIZE || buffer.byteLength < PROC_BSDINFO_SIZE)
    return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  if (view.getUint32(PBI_PID, true) !== pid) return null;
  if (view.getUint32(PBI_STATUS, true) === SZOMB) return null;
  const parentPid = view.getUint32(PBI_PPID, true);
  const seconds = view.getBigUint64(PBI_START_TVSEC, true);
  const microseconds = view.getBigUint64(PBI_START_TVUSEC, true);
  if (seconds === 0n || microseconds >= 1_000_000n) return null;
  return {
    pid,
    parentPid,
    startTicks: `${seconds}.${microseconds.toString().padStart(6, "0")}`,
  };
}

export function parseXucredUid(
  buffer: Uint8Array,
  length: number,
): number | null {
  if (length !== XUCRED_SIZE || buffer.byteLength < XUCRED_SIZE) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  if (view.getUint32(0, true) !== XUCRED_VERSION) return null;
  return view.getUint32(XUCRED_CR_UID, true);
}

export function parsePeerPid(
  buffer: Uint8Array,
  length: number,
): number | null {
  if (length !== PID_SIZE || buffer.byteLength < PID_SIZE) return null;
  const pid = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  ).getInt32(0, true);
  return pid > 0 ? pid : null;
}

const SYMBOLS = {
  getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  flock: { args: ["i32", "i32"], returns: "i32" },
} as const;

function openLibSystem() {
  return dlopen("/usr/lib/libSystem.B.dylib", SYMBOLS);
}

let libSystem: ReturnType<typeof openLibSystem> | null = null;
let loadAttempted = false;

function loadLibSystem(): ReturnType<typeof openLibSystem> | null {
  if (loadAttempted) return libSystem;
  loadAttempted = true;
  if (process.platform !== "darwin") return null;
  try {
    libSystem = openLibSystem();
  } catch {
    console.error(
      "[opencode] libSystem is unavailable; OpenCode office calls will be refused.",
    );
  }
  return libSystem;
}

export function readDarwinProcessHop(pid: number): DarwinProcessHop | null {
  const loaded = loadLibSystem();
  if (!loaded || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE);
  try {
    const written = loaded.symbols.proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      0,
      ptr(buffer),
      PROC_BSDINFO_SIZE,
    );
    return parseProcBsdInfo(buffer, written, pid);
  } catch {
    return null;
  }
}

export function readDarwinPeerCredentials(
  fd: number,
): { pid: number; uid: number } | null {
  const loaded = loadLibSystem();
  if (!loaded) return null;
  const credential = new Uint8Array(XUCRED_SIZE);
  const credentialLength = new Uint32Array([XUCRED_SIZE]);
  const peerPid = new Uint8Array(PID_SIZE);
  const peerPidLength = new Uint32Array([PID_SIZE]);
  try {
    if (
      loaded.symbols.getsockopt(
        fd,
        SOL_LOCAL,
        LOCAL_PEERCRED,
        ptr(credential),
        ptr(credentialLength),
      ) !== 0 ||
      loaded.symbols.getsockopt(
        fd,
        SOL_LOCAL,
        LOCAL_PEERPID,
        ptr(peerPid),
        ptr(peerPidLength),
      ) !== 0
    )
      return null;
  } catch {
    return null;
  }
  const uid = parseXucredUid(credential, credentialLength[0]);
  const pid = parsePeerPid(peerPid, peerPidLength[0]);
  return uid === null || pid === null ? null : { pid, uid };
}

// Blocks until this process holds an exclusive lock on path, and keeps it
// until the process exits. The descriptor is close-on-exec, so a child process
// does not inherit the lock and outlive it.
export function lockDarwinFileUntilExit(path: string): boolean {
  const loaded = loadLibSystem();
  if (!loaded) return false;
  try {
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | O_CLOEXEC,
      0o600,
    );
    return loaded.symbols.flock(fd, LOCK_EX) === 0;
  } catch {
    return false;
  }
}
