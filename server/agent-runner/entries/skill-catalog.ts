// An isolated member's skills page catalog, built as the member
// (server/skill-catalog-runner.ts).
import {
  buildMemberSkillCatalog,
  skillCatalogRequest,
} from "../../skill-catalog-runner.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => buildMemberSkillCatalog(skillCatalogRequest(input)));
