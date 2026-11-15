// A member's Claude session files to the project folder of the agent's new
// cwd, as the member (server/member-move-receive.ts moveClaudeCwd).
import { moveClaudeCwd } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) =>
  moveClaudeCwd(input as Parameters<typeof moveClaudeCwd>[0]),
);
