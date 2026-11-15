// One project skill's file, read as the member at its invocation
// (server/project-skill-scan.ts), within the body bound.
import {
  readProjectSkillBody,
  skillEngineInput,
} from "../../project-skill-scan.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const { cwd, engine } = skillEngineInput(input, "project-skill");
  const name = (input as { name?: unknown }).name;
  if (typeof name !== "string") throw new Error("project-skill needs name");
  return readProjectSkillBody(cwd, engine, name);
});
