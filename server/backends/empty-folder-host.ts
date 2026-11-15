// Makes an empty folder in agent space (backends/empty-folder.ts): the
// runner's empty-folder entry in split mode, in process otherwise.
import {
  inAgentSpace,
  officeAgentHost,
  type AgentHost,
} from "../agent-host.ts";
import { emptyFolderRoots, ensureEmptyFolder } from "./empty-folder.ts";

// `host`: an isolated member's makes it in their agent space, as the member.
export async function makeEmptyFolder(
  dir: string,
  host: AgentHost = officeAgentHost(),
): Promise<string> {
  const roots = emptyFolderRoots(host.agentRoot());
  const made = await inAgentSpace(
    "empty-folder",
    { dir, roots },
    () => ensureEmptyFolder(dir, roots),
    host,
  );
  if (made !== dir) throw new Error(`could not make the empty folder ${dir}`);
  return dir;
}
