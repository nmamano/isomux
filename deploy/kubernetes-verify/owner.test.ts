import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The k3d run deploys owner/kustomization.yaml, so it must be the overlay the
// guide prints, with only the base, the test host and the image digest set.
test("the k3d owner overlay is the guide's overlay", () => {
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
    .replace(
      "REPLACE_WITH_IMAGE_DIGEST",
      "56feb68ff1eea2ece0a6f0f7e8eaf522ad958021d0672fe6fe74abb69a22889c",
    )
    .replaceAll("office.example.com", "office.k8s.test");
  expect(expected).not.toBe(block);
  expect(
    readFileSync(new URL("./owner/kustomization.yaml", import.meta.url), "utf8"),
  ).toBe(expected);
});
