import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { scanCredentialCanaries } from "./credential-scan";

const repoRoot = join(import.meta.dir, "../../..");
const committedArtifactRoots = [
  join(import.meta.dir, "fixtures"),
  join(repoRoot, "internal-docs/opencode-gate/evidence"),
  join(import.meta.dir, "start-server.ts"),
  join(import.meta.dir, "supervisor.ts"),
];

async function committedArtifacts() {
  const files: Array<{ path: string; text: string }> = [];
  for (const root of committedArtifactRoots) {
    if (!root.endsWith("fixtures") && !root.endsWith("evidence")) {
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

    const allowedCanaryHits: Record<string, string[]> = {
      // Recorded raw pre-redaction provider response.
      "internal-docs/opencode-gate/evidence/auth-error-events.jsonl": [
        "provider response header",
      ],
      // Recorded pre-redaction provider response projected into the probe result.
      "internal-docs/opencode-gate/evidence/auth-error-results.json": [
        "provider response header",
      ],
      // Historical scan metadata necessarily names every canary it searched for.
      "internal-docs/opencode-gate/evidence/secret-scan-results.json": [
        "provider credential",
        "V1 server password",
        "V2 server password",
        "provider response header",
      ],
    };
    const expectedHits = Object.entries(allowedCanaryHits)
      .flatMap(([path, classes]) =>
        classes.map((className) => ({ className, path })),
      )
      .sort((a, b) =>
        `${a.path}:${a.className}`.localeCompare(`${b.path}:${b.className}`),
      );
    const hits = scanCredentialCanaries(await committedArtifacts()).sort(
      (a, b) =>
        `${a.path}:${a.className}`.localeCompare(`${b.path}:${b.className}`),
    );
    expect(hits).toEqual(expectedHits);
  });
});
