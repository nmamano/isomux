import * as fs from "node:fs";
import { RUNTIME_REPO_FILES, runtimeRepoFile } from "../runtime-files.ts";

/** Fail the image build when a payload read by the provisioner is absent. */
export function assertRuntimeFiles(root?: string): void {
  for (const name of Object.keys(RUNTIME_REPO_FILES) as Array<
    keyof typeof RUNTIME_REPO_FILES
  >) {
    const file = runtimeRepoFile(name, root);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing provisioner runtime file: ${file}`);
    }
  }
}

if (import.meta.main) assertRuntimeFiles();
