// The member file move on enable (server/member-move-receive.ts), as the
// member: link the staged files to their destinations.
import { placeFiles, type MoveStepInput } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => placeFiles(input as MoveStepInput));
