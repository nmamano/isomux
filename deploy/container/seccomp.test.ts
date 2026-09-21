import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

test("Chromium seccomp profile changes only the three namespace calls from its pinned basis", () => {
  const basis = readFileSync(new URL("./seccomp/docker-default.json", import.meta.url));
  expect(createHash("sha256").update(basis).digest("hex")).toBe(
    "785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334",
  );
  const profile = JSON.parse(readFileSync(new URL("./seccomp/chromium.json", import.meta.url), "utf8"));
  expect(profile.syscalls.pop()).toEqual({
    comment: expect.any(String), names: ["clone", "setns", "unshare"], action: "SCMP_ACT_ALLOW", args: [],
  });
  expect(profile).toEqual(JSON.parse(basis.toString()));
});
