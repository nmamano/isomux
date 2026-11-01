// The empty folder of an agent below standard at chat or office, made and
// checked by the agent user (backends/empty-folder.ts). The server sends
// the roots: the agent user resolves another state root.
import { isAbsolute } from "path";
import { ensureEmptyFolder } from "../../backends/empty-folder.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as { dir?: unknown; roots?: unknown } | null;
  if (typeof req?.dir !== "string" || !isAbsolute(req.dir))
    throw new Error("empty-folder needs an absolute dir");
  const roots = req.roots;
  if (
    !Array.isArray(roots) ||
    !roots.every((root) => typeof root === "string" && isAbsolute(root))
  )
    throw new Error("empty-folder needs absolute roots");
  return ensureEmptyFolder(req.dir, roots as string[]);
});
