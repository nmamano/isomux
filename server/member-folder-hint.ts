// Why a turn of an isolated member's agent failed, when its folder is the
// cause (internal-docs/member-os-user-design.md, section 3.3). The office
// does not stat a member's folder before the engine starts there
// (agent-manager createSession and applySessionCwdForResume, cwd-utils
// diagnoseProcessExit skip it), so after a failed turn the folder is checked
// once through the member's host:
//   - missing: the existing "does not exist" line, no command;
//   - not a folder: the existing "not a directory" line;
//   - no access (EACCES from the stat or the enter): the line with the
//     commands that share the folder for reading with the member's OS user;
//     for a folder at, below or above the office home or the state root, a
//     line with no command, because the member checks (member-hosts.ts,
//     office-home-closed and state-root-closed) fail once the member's OS
//     user can reach either one;
//   - anything else, a folder that is fine, or a host that is not ready:
//     nothing, and the engine's own error stays the turn's line.
import { realpath } from "fs/promises";
import { homedir } from "os";
import { resolve, sep } from "path";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { errCode } from "../shared/errors.ts";
import {
  memberFolderHost,
  readShareCommands,
  resolveAgentCwd,
  statMemberFolder,
} from "./agent-folder.ts";
import { STATE_ROOT } from "./config.ts";
import { memberOsUserState } from "./member-os-users.ts";

export async function memberFolderHint(
  cwd: string,
  userId: string | null | undefined,
): Promise<LogMessage | null> {
  const host = memberFolderHost(userId);
  if (!host) return null;
  try {
    const stat = await statMemberFolder(host, cwd);
    return stat.type === "dir"
      ? null
      : msg("systemEntries.cwdInvalid.notDirectory", { path: cwd });
  } catch (err) {
    switch (errCode(err)) {
      case "ENOENT":
        return msg("systemEntries.cwdInvalid.missing", { path: cwd });
      case "ENOTDIR":
        return msg("systemEntries.cwdInvalid.notDirectory", { path: cwd });
      case "EACCES": {
        // The OS user from the office's record, never from the reply.
        const state = memberOsUserState(userId);
        if (state.kind !== "isolated") return null;
        if (await holdsOfficeFiles(resolveAgentCwd(cwd, userId)))
          return msg("systemEntries.memberFolderOfficeOnly", {
            user: state.osUser.name,
            path: cwd,
          });
        return msg("systemEntries.memberFolderUnreachable", {
          user: state.osUser.name,
          path: cwd,
          commands: readShareCommands(state.osUser.name, cwd)
            .map((command) => `\`${command}\``)
            .join(" "),
        });
      }
      default:
        return null;
    }
  }
}

// The path as the office resolves it, or as written when it cannot.
async function officeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

// True when `a` is `b` or below it, compared on whole path segments.
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b === sep ? b : b + sep);
}

// True when `path` is at, below or above the office home or the state root,
// the places the member checks keep closed to a member's OS user. The same
// values the checks use (member-hosts.ts), resolved.
async function holdsOfficeFiles(path: string): Promise<boolean> {
  const folder = await officeRealpath(path);
  for (const place of [homedir(), STATE_ROOT]) {
    const closed = await officeRealpath(place);
    if (within(folder, closed) || within(closed, folder)) return true;
  }
  return false;
}
