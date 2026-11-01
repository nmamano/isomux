// The empty folder of a Codex thread below standard, made and checked by the
// agent user (backends/codex/access.ts).
import { isAbsolute } from "path";
import { ensureEmptyFolder } from "../../backends/codex/empty-folder.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as { dir?: unknown } | null;
  if (typeof req?.dir !== "string" || !isAbsolute(req.dir))
    throw new Error("codex-empty-cwd needs an absolute dir");
  return ensureEmptyFolder(req.dir);
});
