// The trusted checks of a split-mode start, without the start.
// Run it as the server user; it exits 1 and names each failed check.
//
//   bun server/split/check.ts
//
// Slice 6 of task 01f5038c runs it from isomux-split-users --check.

import { STATE_ROOT } from "../config.ts";
import { checkSplit, describeFailure } from "./start.ts";

const { failures } = checkSplit(STATE_ROOT, Infinity);
for (const failure of failures)
  console.error(`[split] trusted check failed: ${describeFailure(failure)}`);
if (failures.length > 0) process.exit(1);
console.log("[split] trusted checks passed");
