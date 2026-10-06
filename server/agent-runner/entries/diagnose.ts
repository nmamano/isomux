// The runner diagnostic (internal-docs/os-user-split-design.md, section 2.4):
// operations the agent user must be refused. It reports the error code of each
// try. A try that succeeds is undone at once. The server counts only EACCES
// and EPERM as proven; the diagnostic never decides whether split mode starts.
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { runEntry } from "./io.ts";

export interface DiagnoseInput {
  stateFile: string;
  codeFile: string;
  shareRoot: string;
}

function attempt(run: () => void): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unknown";
  }
}

await runEntry((input) => {
  const req = input as Partial<DiagnoseInput> | null;
  if (
    !req ||
    typeof req.stateFile !== "string" ||
    typeof req.codeFile !== "string" ||
    typeof req.shareRoot !== "string"
  )
    throw new Error("diagnose needs stateFile, codeFile and shareRoot");
  const { stateFile, codeFile, shareRoot } = req;
  const moved = `${codeFile}.isomux-diagnostic`;
  const created = join(shareRoot, `.isomux-diagnostic-${process.pid}`);
  return {
    readState: attempt(() => void readFileSync(stateFile)),
    // O_WRONLY without O_TRUNC: a success changes nothing.
    writeCode: attempt(() => closeSync(openSync(codeFile, constants.O_WRONLY))),
    renameCode: attempt(() => {
      renameSync(codeFile, moved);
      renameSync(moved, codeFile);
    }),
    createInShare: attempt(() => {
      closeSync(
        openSync(
          created,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        ),
      );
      unlinkSync(created);
    }),
  };
});
