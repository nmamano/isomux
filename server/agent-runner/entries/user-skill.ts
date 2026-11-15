// One user, plugin or synced skill's file, read as the member at its
// invocation (server/user-skill-scan.ts), within the body bound.
import {
  readUserSkillBody,
  userSkillScanInput,
} from "../../user-skill-scan.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const request = userSkillScanInput(input, "user-skill");
  const name = (input as { name?: unknown }).name;
  if (typeof name !== "string") throw new Error("user-skill needs name");
  return readUserSkillBody(request, name);
});
