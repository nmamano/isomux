// The member file move on enable: the files the office streams, staged in
// the agent space as the member (server/member-move-receive.ts).
import { receiveFiles, type MoveInInput } from "../../member-move-receive.ts";
import { runStreamEntry } from "./io.ts";

await runStreamEntry((input, body) => receiveFiles(input as MoveInInput, body));
