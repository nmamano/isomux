import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { scanCredentialCanaries } from "./credential-scan";

const repoRoot = join(import.meta.dir, "../../..");
// Only surfaces that still change: the frozen August gate evidence under
// internal-docs/opencode-gate/evidence was scanned once and is not re-scanned
// on every run (Nil, 2026-09-13).
const committedArtifactRoots = [
  join(import.meta.dir, "fixtures"),
  join(import.meta.dir, "start-server.ts"),
  join(import.meta.dir, "supervisor.ts"),
];

async function committedArtifacts() {
  const files: Array<{ path: string; text: string }> = [];
  for (const root of committedArtifactRoots) {
    if (!root.endsWith("fixtures")) {
      files.push({
        path: relative(repoRoot, root),
        text: await Bun.file(root).text(),
      });
      continue;
    }
    for await (const name of new Bun.Glob("**/*").scan({
      cwd: root,
      onlyFiles: true,
    })) {
      const path = join(root, name);
      files.push({
        path: relative(repoRoot, path),
        text: await Bun.file(path).text(),
      });
    }
  }
  return files;
}

describe("OpenCode committed credential scan", () => {
  it("detects a direct synthetic control and keeps committed persistence surfaces clean", async () => {
    const control = {
      className: "synthetic control",
      value: "SYNTHETIC_OC1_CONTROL_VALUE",
    };
    expect(
      scanCredentialCanaries(
        [{ path: "direct-input", text: control.value }],
        [control],
      ),
    ).toEqual([{ className: control.className, path: "direct-input" }]);

    // The live surfaces carry no canary at all. (The frozen gate evidence had
    // recorded, documented hits; it is no longer scanned.)
    expect(scanCredentialCanaries(await committedArtifacts())).toEqual([]);
  });
});
