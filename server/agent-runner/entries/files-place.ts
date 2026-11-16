// The member file move on enable and the restore of a member's space
// (server/member-move-receive.ts), as the member: link the staged files to
// their destinations.
import { placeFiles, type PlaceInput } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => placeFiles(input as PlaceInput));
