// An office move (server/member-home-receive.ts): her moved home, streamed
// by the office, written into her home's staging folder as the member.
import { receiveTree, type TreeInInput } from "../../member-home-receive.ts";
import { runStreamEntry } from "./io.ts";

await runStreamEntry((input, body) => receiveTree(input as TreeInInput, body));
