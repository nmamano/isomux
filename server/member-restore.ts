// The restore of isolated members' agent spaces from a backup copy
// (internal-docs/member-os-user-design.md, slice 3c-ii):
//
//   bun run server/isomux-office.ts restore-member-spaces <copy folder>
//
// Run as the office user, with or without a running office. The office
// reads the copy and hands each member's files to their runner, which writes
// them as the member (files-in, then files-place with `keep`): a file that is
// there already is kept, never replaced.
//
// What it defends: an office file must never be sent into a member's space,
// and a member's bytes must never act on the admin's terminal. So no source
// path has a link from the copy folder down, every path passes the
// exclusions as they are now (login files are never restored), the
// destination is the member's passwd home, never their runner's word, and
// every name or reason that carries the member's text is printed
// JSON-quoted.
//
// A member is restored only when member-os-users.json, passwd and their
// runner (peer-checked socket) all name the OS user and uid in their
// member.json. Anything else refuses that member; the others go on.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, join } from "node:path";
import { MEMBER_AGENT_DIR } from "./agent-host.ts";
import {
  readRunnerInfo,
  runRunnerEntry,
  type RunnerInfo,
  type RunnerTarget,
} from "./agent-runner/client.ts";
import { COPY_MARKER } from "./backup-copies.ts";
import { passwdHome } from "./locked-member-apps.ts";
import {
  MEMBER_MANIFEST,
  MEMBER_MARKER,
  MEMBER_SPACE,
  MEMBERS_DIR,
  normalisedRel,
  readMemberManifest,
  readMemberMarker,
} from "./member-backup.ts";
import { memberRunnerSocketPath } from "./member-hosts.ts";
import { MOVE_IN_TIMEOUT_MS, MOVE_STEP_TIMEOUT_MS } from "./member-move.ts";
import {
  memberOsUserStateAt,
  type MemberOsUserState,
} from "./member-os-users.ts";
import { memberSpaceExcluded } from "./member-space-exclusions.ts";
import { readPeerCredentials } from "./unix-socket-server.ts";

// The longest the runner may take to answer "info".
export const INFO_BOUND_MS = 10_000;
// The names printed per kind of file that is not restored.
const NAMES_SHOWN = 20;

export const RESTORE_OK = 0;
export const RESTORE_MEMBER_REFUSED = 1;
export const RESTORE_REFUSED = 2;

// One member's runner, reached with the peer check.
export interface RestoreRunner {
  info(): Promise<Pick<RunnerInfo, "uid" | "user">>;
  entry(name: string, input: unknown, timeoutMs: number): Promise<unknown>;
  stream(
    name: string,
    input: unknown,
    body: AsyncIterable<Uint8Array>,
    timeoutMs: number,
  ): Promise<unknown>;
}

export interface RestoreDeps {
  stateRoot: string;
  memberState?: (userId: string) => MemberOsUserState;
  home?: (name: string, uid: number) => string | null;
  runner?: (name: string, uid: number) => RestoreRunner;
  out?: (line: string) => void;
}

function peerCheckedRunner(name: string, uid: number): RestoreRunner {
  const target: RunnerTarget = {
    path: memberRunnerSocketPath(name),
    peer: { uid, read: (fd) => readPeerCredentials(fd)?.uid ?? null },
  };
  return {
    info: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no answer in ${INFO_BOUND_MS / 1000} s`)),
          INFO_BOUND_MS,
        );
        readRunnerInfo(target).then(
          (info) => {
            clearTimeout(timer);
            resolve(info);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
    entry: (entry, input, timeoutMs) =>
      runRunnerEntry(target, entry, input, timeoutMs),
    stream: (entry, input, body, timeoutMs) =>
      runRunnerEntry(target, entry, input, timeoutMs, body),
  };
}

const quote = (text: string) => JSON.stringify(text);
const fileCount = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const errText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// A folder of the copy that is a real folder, not a link to one.
function realFolder(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st !== undefined && st.isDirectory();
}

class Names {
  readonly names: string[] = [];
  count = 0;
  add(name: string): void {
    this.count++;
    if (this.names.length < NAMES_SHOWN) this.names.push(name);
  }
  text(): string {
    const more =
      this.count > this.names.length
        ? ` and ${this.count - this.names.length} more`
        : "";
    return `${this.names.map(quote).join(", ")}${more}`;
  }
}

interface Planned {
  p: string;
  source: string;
  dest: string;
  size: number;
  mode: number;
}

interface MemberOutcome {
  ok: boolean;
  lines: string[];
}

// The copy's backup.json, when it names this office's state root.
function copyRefusal(copy: string, stateRoot: string): string | null {
  if (basename(copy).endsWith(".partial"))
    return "it is a backup that did not finish";
  let marker: { kind?: unknown; office?: unknown };
  try {
    const path = join(copy, COPY_MARKER);
    if (!lstatSync(path).isFile()) return `its ${COPY_MARKER} is not a file`;
    marker = JSON.parse(readFileSync(path, "utf8")) as typeof marker;
  } catch {
    return `its ${COPY_MARKER} cannot be read`;
  }
  if (marker?.kind !== "folder") return "it is not a folder copy";
  if (marker.office !== stateRoot)
    return `it is a copy of another office (${quote(String(marker.office))})`;
  if (!realFolder(join(copy, MEMBERS_DIR))) return "it holds no member spaces";
  return null;
}

// The files of one member's copy to send, and what is left out.
async function plan(
  dir: string,
  agentRoot: string,
): Promise<{
  files: Planned[];
  skipped: Names;
  links: Names;
  excluded: number;
}> {
  const space = join(dir, MEMBER_SPACE);
  const skipped = new Names();
  const links = new Names();
  let excluded = 0;
  const files: Planned[] = [];
  if (!realFolder(space))
    throw new Error(`its ${MEMBER_SPACE} is not a folder`);
  if (!lstatSync(join(dir, MEMBER_MANIFEST)).isFile())
    throw new Error(`its ${MEMBER_MANIFEST} is not a file`);
  // Folders of space/ known to be real folders.
  const real = new Set<string>([""]);
  const noLinkTo = (rel: string): boolean => {
    const parts = rel.split("/");
    let at = "";
    for (const part of parts.slice(0, -1)) {
      at = at ? `${at}/${part}` : part;
      if (real.has(at)) continue;
      if (!realFolder(join(space, at))) return false;
      real.add(at);
    }
    return true;
  };
  for (const line of await readMemberManifest(dir)) {
    if (line.k !== "f" && line.k !== "l") continue;
    if (!normalisedRel(line.p)) {
      skipped.add(String(line.p));
      continue;
    }
    if (memberSpaceExcluded(line.p)) {
      excluded++;
      continue;
    }
    if (line.k === "l") {
      links.add(line.p);
      continue;
    }
    if (
      !Number.isSafeInteger(line.s) ||
      (line.s as number) < 0 ||
      !noLinkTo(line.p)
    ) {
      skipped.add(line.p);
      continue;
    }
    files.push({
      p: line.p,
      source: join(space, line.p),
      dest: join(agentRoot, line.p),
      size: line.s as number,
      mode: Number.isInteger(line.o) ? (line.o as number) : 0o600,
    });
  }
  return { files, skipped, links, excluded };
}

const u32 = (n: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(n, 0);
  return buffer;
};

// files-in records: each source opened with no link at its end, and sent
// only when it is a regular file of its manifest size.
async function* records(
  files: Planned[],
  skipped: Names,
): AsyncGenerator<Uint8Array> {
  for (const file of files) {
    let fd: number;
    try {
      fd = openSync(
        file.source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      skipped.add(file.p);
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== file.size) {
        skipped.add(file.p);
        continue;
      }
      const header = Buffer.from(
        JSON.stringify({ dest: file.dest, size: file.size, mode: file.mode }),
      );
      yield Buffer.concat([u32(header.length), header]);
      let left = file.size;
      while (left > 0) {
        const buffer = Buffer.alloc(Math.min(left, 1024 * 1024));
        const n = readSync(fd, buffer, 0, buffer.length, null);
        // The stream cannot take back a header: a short file ends the run.
        if (n === 0) throw new Error(`${quote(file.p)} became shorter`);
        left -= n;
        yield buffer.subarray(0, n);
      }
    } finally {
      closeSync(fd);
    }
  }
  yield u32(0);
}

async function restoreMember(
  copy: string,
  userId: string,
  deps: Required<Omit<RestoreDeps, "stateRoot" | "out">>,
): Promise<MemberOutcome> {
  const refused = (why: string): MemberOutcome => ({
    ok: false,
    lines: [`${userId}: refused: ${why}`],
  });
  const dir = join(copy, MEMBERS_DIR, userId);
  if (!realFolder(dir)) return refused("its folder in the copy is a link");
  const markerPath = join(dir, MEMBER_MARKER);
  if (!lstatSync(markerPath, { throwIfNoEntry: false })?.isFile())
    return refused(`its ${MEMBER_MARKER} is not a file`);
  const marker = readMemberMarker(dir);
  if (!marker || marker.userId !== userId)
    return refused(`its ${MEMBER_MARKER} does not name this member`);
  if (marker.state === "skipped")
    return refused("the copy has no files of theirs");
  const { name, uid } = marker.osUser ?? {};
  const state = deps.memberState(userId);
  if (state.kind !== "isolated")
    return refused("this office does not run them as their own OS user");
  if (state.osUser.name !== name || state.osUser.uid !== uid)
    return refused(
      `this office runs them as ${state.osUser.name} (uid ${state.osUser.uid}), the copy was made as ${quote(String(name))} (uid ${quote(String(uid))})`,
    );
  const home = deps.home(name, uid);
  if (!home) return refused(`passwd has no ${quote(name)} with uid ${uid}`);
  const runner = deps.runner(name, uid);
  try {
    const info = await runner.info();
    if (info.uid !== uid || info.user !== name)
      return refused("their runner answers as another user");
  } catch (error) {
    return refused(`their runner did not answer: ${quote(errText(error))}`);
  }
  const agentRoot = join(home, MEMBER_AGENT_DIR);
  let planned: Awaited<ReturnType<typeof plan>>;
  try {
    planned = await plan(dir, agentRoot);
  } catch (error) {
    return refused(`the copy cannot be read: ${quote(errText(error))}`);
  }
  const { files, skipped, links, excluded } = planned;
  const asOf = new Date(marker.copiedAt ?? marker.at).toISOString();
  const from =
    marker.state === "carried" && marker.carriedFrom
      ? ` (made in ${quote(marker.carriedFrom)})`
      : "";
  let placed = 0;
  const kept = new Names();
  if (files.length > 0) {
    const nonce = randomBytes(16).toString("hex");
    const step = { nonce, agentRoot };
    const total = files.reduce((sum, file) => sum + file.size, 0);
    try {
      await runner.stream(
        "files-in",
        { ...step, home, total },
        records(files, skipped),
        MOVE_IN_TIMEOUT_MS,
      );
      const answer = (await runner.entry(
        "files-place",
        { ...step, keep: true },
        MOVE_STEP_TIMEOUT_MS,
      )) as { placed?: unknown; kept?: unknown };
      placed = typeof answer?.placed === "number" ? answer.placed : 0;
      if (Array.isArray(answer?.kept))
        for (const dest of answer.kept)
          kept.add(
            String(dest).startsWith(`${agentRoot}/`)
              ? String(dest).slice(agentRoot.length + 1)
              : String(dest),
          );
    } catch (error) {
      try {
        await runner.entry("files-undo", step, MOVE_STEP_TIMEOUT_MS);
      } catch (undoError) {
        return {
          ok: false,
          lines: [
            `${userId}: failed: ${quote(errText(error))}; the files placed could not be removed: ${quote(errText(undoError))}`,
          ],
        };
      }
      return {
        ok: false,
        lines: [
          `${userId}: failed, nothing restored: ${quote(errText(error))}`,
        ],
      };
    }
    try {
      await runner.entry("files-done", step, MOVE_STEP_TIMEOUT_MS);
    } catch {}
  }
  const lines = [
    `${userId}: restored ${fileCount(placed)} of their space as of ${asOf}${from}`,
  ];
  if (kept.count > 0)
    lines.push(`  kept ${fileCount(kept.count)} already there: ${kept.text()}`);
  if (skipped.count > 0)
    lines.push(
      `  not restored, ${fileCount(skipped.count)} missing or changed in the copy: ${skipped.text()}`,
    );
  if (links.count > 0)
    lines.push(
      `  not restored, ${links.count} ${links.count === 1 ? "link" : "links"}: ${links.text()}`,
    );
  if (excluded > 0)
    lines.push(
      `  not restored, ${fileCount(excluded)} that backups now leave out`,
    );
  return { ok: true, lines };
}

// The CLI. Returns its exit code.
export async function restoreMemberSpaces(
  copyArg: string | undefined,
  deps: RestoreDeps,
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (!copyArg) {
    out(
      "usage: bun run server/isomux-office.ts restore-member-spaces <copy folder>",
    );
    return RESTORE_REFUSED;
  }
  let copy: string;
  try {
    copy = realpathSync(copyArg);
  } catch (error) {
    out(`refused: ${quote(copyArg)} cannot be read: ${quote(errText(error))}`);
    return RESTORE_REFUSED;
  }
  const refusal = copyRefusal(copy, deps.stateRoot);
  if (refusal) {
    out(`refused: ${quote(copy)}: ${refusal}`);
    return RESTORE_REFUSED;
  }
  const full = {
    memberState: deps.memberState ?? memberOsUserStateAt(deps.stateRoot),
    home: deps.home ?? passwdHome,
    runner: deps.runner ?? peerCheckedRunner,
  };
  let code = RESTORE_OK;
  for (const name of readdirSync(join(copy, MEMBERS_DIR)).sort()) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      out(`${quote(name)}: refused: not a member id`);
      code = RESTORE_MEMBER_REFUSED;
      continue;
    }
    let outcome: MemberOutcome;
    try {
      outcome = await restoreMember(copy, name, full);
    } catch (error) {
      outcome = {
        ok: false,
        lines: [`${name}: failed: ${quote(errText(error))}`],
      };
    }
    for (const line of outcome.lines) out(line);
    if (!outcome.ok) code = RESTORE_MEMBER_REFUSED;
  }
  out(
    "Login files are never restored: each restored member signs in to their providers again.",
  );
  return code;
}
