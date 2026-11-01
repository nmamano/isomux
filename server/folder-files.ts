// Isomux's file tools for a Codex agent at the folder and web stops (task
// 25015e41). Codex 0.164 has no tool that reads a file without the shell, so
// Isomux serves read_file, list_dir and grep_files on its isomux_files MCP
// server (server/folder-mcp-endpoint.ts). Their schemas follow Codex's own
// experimental tools of the same names.
//
// folderFilesCall runs in a short-lived child process in agent space
// (server/folder-files-host.ts), never in the server: a slow regex or a big
// read stops only that child, which a wall-clock limit kills.

import { Glob } from "bun";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { stopHasFolder, type AgentAccess } from "../shared/agent-access.ts";
import { evaluateProposedAction } from "./safety-policy.ts";

// The MCP server that serves the tools (folder-mcp-endpoint.ts): its name in
// the Codex thread config, and its path on the office server.
export const FOLDER_FILES_MCP_SERVER = "isomux_files";
export const FOLDER_FILES_MCP_PATH = "/mcp/files";

export const FOLDER_FILES_TOOLS = [
  "read_file",
  "list_dir",
  "grep_files",
] as const;

export type FolderFilesTool = (typeof FOLDER_FILES_TOOLS)[number];

export interface FolderFilesRequest {
  tool: FolderFilesTool;
  // The tool call's arguments, as the model sent them.
  args: unknown;
  // The agent's folder and stop, from the server's agent record at call time.
  folder: string;
  access: AgentAccess;
  // The agent's Codex home, for the sensitive file check.
  codexHome?: string;
}

export type FolderFilesResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// The wall-clock limit of one call, child start included.
export const FOLDER_FILES_TIMEOUT_MS = 10_000;

export const FOLDER_FILES_LIMITS = {
  // Files and folders one list_dir or grep_files call visits.
  maxEntriesWalked: 20_000,
  // Bytes read_file and grep_files read from one file.
  maxBytesPerFile: 4 * 1024 * 1024,
  // Characters of one line in read_file's answer.
  maxLineChars: 500,
  // Bytes of one answer.
  maxOutputBytes: 256 * 1024,
} as const;

const BINARY_PROBE_BYTES = 8192;
const READ_FILE_DEFAULT_LIMIT = 2000;
const LIST_DIR_DEFAULT_LIMIT = 25;
const LIST_DIR_DEFAULT_DEPTH = 2;
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 2000;
// Folders a search never enters: a repository's own store.
const GREP_SKIP_DIRS: ReadonlySet<string> = new Set([".git"]);

// The confinement and the sensitive file check of a read of `path` by
// `toolName` (Read or Grep): the same checks Claude's file tools get at the
// folder stop (safety-policy.ts).
function readDecision(
  req: FolderFilesRequest,
  toolName: "Read" | "Grep",
  input: Record<string, unknown>,
): string | null {
  const decision = evaluateProposedAction(
    { kind: "read-files", toolName, input },
    {
      cwd: req.folder,
      codexHome: req.codexHome,
      confine: {
        access: req.access,
        folder: req.folder,
        tools: ["read", "grep"],
      },
    },
  );
  return decision.decision === "deny" ? decision.reason : null;
}

function within(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

class Refusal extends Error {}

// The real path of `path` the model named, checked again at open time: it
// must be inside the folder's real path.
function realInside(req: FolderFilesRequest, path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Refusal(`${path} does not exist.`);
  }
  if (!within(real, realpathSync(req.folder)))
    throw new Refusal(`${path} is not inside your folder.`);
  return real;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Refusal(`${key} must be a path.`);
  if (value.startsWith("~"))
    throw new Refusal(`${key} must be inside your folder.`);
  return value;
}

function countArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Refusal(`${key} must be a whole number of 1 or more.`);
  return value;
}

// The first `max` bytes of a file, or null for a binary file (a NUL byte
// early on).
function readHead(path: string, max: number): Buffer | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(max, fstatSync(fd).size));
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const head = buffer.subarray(0, read);
    return head.subarray(0, BINARY_PROBE_BYTES).includes(0) ? null : head;
  } finally {
    closeSync(fd);
  }
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Lines joined while they fit the output cap; `more` is added when some did
// not.
function capped(lines: string[], more: string): string {
  const max = FOLDER_FILES_LIMITS.maxOutputBytes - Buffer.byteLength(more) - 1;
  let bytes = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > max) {
      kept.push(more);
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return kept.join("\n");
}

function readFile(req: FolderFilesRequest, args: Record<string, unknown>) {
  const target = resolve(req.folder, pathArg(args, "file_path"));
  const offset = countArg(args, "offset", 1);
  const limit = countArg(args, "limit", READ_FILE_DEFAULT_LIMIT);
  const refusal = readDecision(req, "Read", { file_path: target });
  if (refusal) throw new Refusal(refusal);
  const real = realInside(req, target);
  if (!statSync(real).isFile()) throw new Refusal(`${target} is not a file.`);
  const head = readHead(real, FOLDER_FILES_LIMITS.maxBytesPerFile);
  if (!head)
    throw new Refusal(`${target} is a binary file: read_file reads text.`);
  const lines = linesOf(head.toString("utf8"));
  if (offset > Math.max(lines.length, 1))
    throw new Refusal(
      `offset ${offset} is past the end of the file (${lines.length} lines).`,
    );
  const max = FOLDER_FILES_LIMITS.maxLineChars;
  const shown = lines
    .slice(offset - 1, offset - 1 + limit)
    .map(
      (line, i) =>
        `L${offset + i}: ${line.length > max ? line.slice(0, max) : line}`,
    );
  return capped(
    shown,
    "[The answer is cut here: read on with a larger offset.]",
  );
}

interface Entry {
  path: string;
  depth: number;
  label: string;
}

// The entries below `dir`, sorted by name, to `depth` levels. A symlink is
// listed, never followed. Stops at the walk cap.
function walkDir(dir: string, depth: number, out: Entry[], level = 1): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    if (out.length >= FOLDER_FILES_LIMITS.maxEntriesWalked) return false;
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    const isDir = stat.isDirectory();
    const label = stat.isSymbolicLink()
      ? `${name}@`
      : isDir
        ? `${name}/`
        : name;
    out.push({ path, depth: level, label });
    if (isDir && level < depth && !walkDir(path, depth, out, level + 1))
      return false;
  }
  return true;
}

function listDir(req: FolderFilesRequest, args: Record<string, unknown>) {
  const target = resolve(req.folder, pathArg(args, "dir_path"));
  const offset = countArg(args, "offset", 1);
  const limit = countArg(args, "limit", LIST_DIR_DEFAULT_LIMIT);
  const depth = countArg(args, "depth", LIST_DIR_DEFAULT_DEPTH);
  const refusal = readDecision(req, "Read", { file_path: target });
  if (refusal) throw new Refusal(refusal);
  // A symlink to a folder is listed, never walked into: the path the model
  // names may not be one either.
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Refusal(`${target} is a symlink: list_dir does not follow it.`);
  const real = realInside(req, target);
  if (!statSync(real).isDirectory())
    throw new Refusal(`${target} is not a folder.`);
  const entries: Entry[] = [];
  const complete = walkDir(real, depth, entries);
  const page = entries.slice(offset - 1, offset - 1 + limit);
  const lines = [
    `Absolute path: ${real}`,
    ...page.map((e) => `${"  ".repeat(e.depth - 1)}${e.label}`),
  ];
  if (offset - 1 + limit < entries.length)
    lines.push(
      `More than ${limit} entries: list on with offset ${offset + limit}.`,
    );
  if (!complete)
    lines.push(
      "The folder has more entries than one call walks: list a sub folder.",
    );
  return capped(
    lines,
    "[The answer is cut here: list on with a larger offset.]",
  );
}

function grepFiles(req: FolderFilesRequest, args: Record<string, unknown>) {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || pattern.length === 0)
    throw new Refusal("pattern must be a regular expression.");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Refusal(
      `pattern is not a valid regular expression: ${(error as Error).message}`,
    );
  }
  const include = args.include;
  if (include !== undefined && include !== null && typeof include !== "string")
    throw new Refusal("include must be a glob.");
  const glob =
    typeof include === "string" && include ? new Glob(include) : null;
  const root = resolve(
    req.folder,
    args.path === undefined || args.path === null ? "." : pathArg(args, "path"),
  );
  const limit = Math.min(
    countArg(args, "limit", GREP_DEFAULT_LIMIT),
    GREP_MAX_LIMIT,
  );
  const refusal = readDecision(req, "Grep", { path: root });
  if (refusal) throw new Refusal(refusal);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Refusal(`${root} is a symlink: grep_files does not follow it.`);
  const realRoot = realInside(req, root);
  const realFolder = realpathSync(req.folder);

  const matches: { path: string; mtime: number }[] = [];
  let walked = 0;
  let complete = true;
  const check = (path: string, mtime: number) => {
    const rel = relative(realFolder, path);
    if (glob && !glob.match(rel) && !glob.match(basename(path))) return;
    // Never a secret: a match would read it one guess at a time.
    if (readDecision(req, "Read", { file_path: path })) return;
    let head: Buffer | null;
    try {
      head = readHead(path, FOLDER_FILES_LIMITS.maxBytesPerFile + 1);
    } catch {
      return;
    }
    if (!head || head.length > FOLDER_FILES_LIMITS.maxBytesPerFile) return;
    if (linesOf(head.toString("utf8")).some((line) => regex.test(line)))
      matches.push({ path, mtime });
  };
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++walked > FOLDER_FILES_LIMITS.maxEntriesWalked) {
        complete = false;
        return;
      }
      const path = join(dir, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      // A symlink is never followed, to a file or a folder.
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!GREP_SKIP_DIRS.has(name)) visit(path);
        if (!complete) return;
      } else if (stat.isFile()) check(path, stat.mtimeMs);
    }
  };
  const rootStat = statSync(realRoot);
  if (rootStat.isDirectory()) visit(realRoot);
  else if (rootStat.isFile()) check(realRoot, rootStat.mtimeMs);

  if (matches.length === 0)
    return complete
      ? "No matches found."
      : "No matches found in the files one call walks: search a sub folder.";
  matches.sort((a, b) => b.mtime - a.mtime);
  const lines = matches.slice(0, limit).map((m) => m.path);
  if (matches.length > limit)
    lines.push(`More than ${limit} files match: narrow the search.`);
  if (!complete)
    lines.push("The search stopped at the walk limit: search a sub folder.");
  return capped(lines, "[The answer is cut here: narrow the search.]");
}

// One tool call: the folder confinement and the sensitive file check first,
// then the read. Synchronous: it runs alone in its child process.
export function folderFilesCall(req: FolderFilesRequest): FolderFilesResult {
  try {
    if (!stopHasFolder(req.access))
      throw new Refusal("This agent has no file tools.");
    if (typeof req.folder !== "string" || !isAbsolute(req.folder))
      throw new Refusal("This agent has no folder.");
    if (!isRecord(req.args))
      throw new Refusal("The tool's arguments must be an object.");
    switch (req.tool) {
      case "read_file":
        return { ok: true, text: readFile(req, req.args) };
      case "list_dir":
        return { ok: true, text: listDir(req, req.args) };
      case "grep_files":
        return { ok: true, text: grepFiles(req, req.args) };
      default:
        throw new Refusal(`${String(req.tool)} is not a file tool.`);
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
