// The member file move on enable (server/member-move-receive.ts), as the
// member: remove the staging folder of a kept move.
import { doneFiles, type MoveStepInput } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => doneFiles(input as MoveStepInput));
