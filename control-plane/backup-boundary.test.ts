// The control-plane key lifecycle says a destroyed temporary key stays
// destroyed. This test guards the structural backup boundary: the office backup
// source and the provisioner key directory are separate roots, and backup code
// does not gain an exclusion list that could silently miss a future key path.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_ROOT as OFFICE_STATE_ROOT } from "../server/config.ts";
import { KEYS_DIR, STATE_ROOT as CONTROL_PLANE_STATE_ROOT } from "./config.ts";

test("temporary provisioning keys are structurally outside office backups", () => {
  expect(path.dirname(KEYS_DIR)).toBe(CONTROL_PLANE_STATE_ROOT);
  expect(
    path
      .resolve(KEYS_DIR)
      .startsWith(`${path.resolve(OFFICE_STATE_ROOT)}${path.sep}`),
  ).toBe(false);

  const source = fs.readFileSync(
    path.join(import.meta.dir, "../server/backup.ts"),
    "utf8",
  );
  expect(source).toContain('import { STATE_ROOT } from "./config.ts"');
  expect(source).not.toContain("KEYS_DIR");
  expect(source).not.toContain("isomux-control-plane");
  expect(source).not.toMatch(/exclude.*key/i);
});
