// The project skills of a working folder, read as the member
// (server/project-skill-scan.ts): names, kinds and descriptions, no paths.
import {
  scanProjectSkillList,
  skillEngineInput,
} from "../../project-skill-scan.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const { cwd, engine } = skillEngineInput(input, "project-skills");
  return scanProjectSkillList(cwd, engine);
});
