import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The k3d run deploys owner/kustomization.yaml, so it must be the overlay the
// guide prints, with only the base, the test host and the image digest set.
// The digest is the release run.sh pulls.
test("the k3d owner overlay is the guide's overlay", () => {
  const digest = readFileSync(
    new URL("./run.sh", import.meta.url),
    "utf8",
  ).match(/^RELEASED=\S+@sha256:([0-9a-f]{64})$/m)![1]!;
  const guide = readFileSync(
    new URL("../../docs/hosting/kubernetes.md", import.meta.url),
    "utf8",
  );
  const block = guide.match(/```yaml\n([\s\S]*?)```/)![1];
  const expected = block
    .replace(
      "https://github.com/nmamano/isomux//deploy/kubernetes?ref=REPLACE_WITH_RELEASE_TAG",
      "../../kubernetes",
    )
    .replace("REPLACE_WITH_IMAGE_DIGEST", digest)
    .replaceAll("office.example.com", "office.k8s.test");
  expect(expected).not.toBe(block);
  expect(
    readFileSync(
      new URL("./owner/kustomization.yaml", import.meta.url),
      "utf8",
    ),
  ).toBe(expected);
});
