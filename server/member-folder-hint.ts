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
//   - anything else, a folder that is fine, or a host that is not ready:
//     nothing, and the engine's own error stays the turn's line.
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { errCode } from "../shared/errors.ts";
import {
  memberFolderHost,
  readShareCommands,
  statMemberFolder,
} from "./agent-folder.ts";
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
