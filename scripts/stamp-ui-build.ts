// Run by scripts/build.sh before the publish: stamps the build id into the
// staged index.html (server/ui-build.ts).
import { stampUiBuild } from "../server/ui-build.ts";

const stageDir = process.argv[2];
if (!stageDir) {
  console.error("Usage: bun run scripts/stamp-ui-build.ts STAGE_DIR");
  process.exit(2);
}
stampUiBuild(stageDir);
