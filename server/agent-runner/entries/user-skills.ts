// The user, plugin and synced skills of an isolated member's agent, read as
// the member (server/user-skill-scan.ts): names, kinds and descriptions, no
// paths.
import {
  scanUserSkillLists,
  userSkillScanInput,
} from "../../user-skill-scan.ts";
import { runEntry } from "./io.ts";

await runEntry((input) =>
  scanUserSkillLists(userSkillScanInput(input, "user-skills")),
);
