// The control-plane key lifecycle says a destroyed temporary key stays
// destroyed. This test guards the structural backup boundary: the office backup
// copies the office state root, and the provisioner key directory is outside it.

import { expect, test } from "bun:test";
import * as path from "node:path";
import { resolveStateRoot } from "../server/config.ts";
import { KEYS_DIR } from "./config.ts";

test("temporary provisioning keys are structurally outside office backups", () => {
  // The default root, not STATE_ROOT: the test preload points ISOMUX_HOME at a
  // temp dir, and a temp dir would pass for any KEYS_DIR.
  const officeRoot = resolveStateRoot({});
  const keys = path.resolve(KEYS_DIR);
  expect(
    keys === officeRoot || keys.startsWith(`${officeRoot}${path.sep}`),
  ).toBe(false);
});
