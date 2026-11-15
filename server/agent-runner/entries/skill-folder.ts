// An isolated member's skill folder, built as the member
// (server/skill-folder-runner.ts): {path} of the folder the engine gets.
import {
  buildSkillFolderAsMember,
  skillFolderRequest,
} from "../../skill-folder-runner.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => ({
  path: buildSkillFolderAsMember(skillFolderRequest(input)),
}));
