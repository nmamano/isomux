// The member file move on enable (server/member-move-receive.ts), as the
// member: remove what files-place placed.
import { undoFiles, type MoveStepInput } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => undoFiles(input as MoveStepInput));
