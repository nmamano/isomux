// An office move (server/member-home-receive.ts): her moved home, from the
// staging folder into her home, as the member.
import { placeTree, type TreePlaceInput } from "../../member-home-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => placeTree(input as TreePlaceInput));
