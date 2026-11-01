// Makes an empty folder in agent space (backends/empty-folder.ts): the
// runner's empty-folder entry in split mode, in process otherwise.
import { inAgentSpace } from "../agent-host.ts";
import { emptyFolderRoots, ensureEmptyFolder } from "./empty-folder.ts";

export async function makeEmptyFolder(dir: string): Promise<string> {
  const roots = emptyFolderRoots();
  const made = await inAgentSpace("empty-folder", { dir, roots }, () =>
    ensureEmptyFolder(dir, roots),
  );
  if (made !== dir) throw new Error(`could not make the empty folder ${dir}`);
  return dir;
}
