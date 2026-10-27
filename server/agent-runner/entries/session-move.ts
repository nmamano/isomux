// Moves one conversation between two accounts of the same engine, as the
// agent user (server/session-account-move.ts): the account folders are agent
// space in split mode.
import {
  copySessionFiles,
  parseSessionMoveRequest,
  removeSessionSource,
} from "../../session-account-move.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const { op, move } = parseSessionMoveRequest(input);
  if (op === "copy") copySessionFiles(move);
  else removeSessionSource(move);
  return true;
});
