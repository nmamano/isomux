// The whole /isomux-diff as the agent user: directory resolution, git with the
// agent's repo config, and the untracked-file reads.
import { runIsomuxDiff, type IsomuxDiffRequest } from "../../isomux-diff.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as Partial<IsomuxDiffRequest> | null;
  if (!req || typeof req.agentCwd !== "string")
    throw new Error("diff needs agentCwd");
  return runIsomuxDiff({
    agentCwd: req.agentCwd,
    dir: typeof req.dir === "string" ? req.dir : undefined,
    commit: typeof req.commit === "string" ? req.commit : undefined,
  });
});
