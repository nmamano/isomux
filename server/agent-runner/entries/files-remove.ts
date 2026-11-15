// The member's copies after a move back, or a removed member's trees, as
// the member (server/member-move-receive.ts removeSent).
import { removeSent } from "../../member-move-receive.ts";
import { runEntry } from "./io.ts";

await runEntry((input) =>
  removeSent(input as Parameters<typeof removeSent>[0]),
);
