import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Render entrypoint and office agree on container supervisor selection", () => {
  const entrypoint = readFileSync(new URL("./entrypoint.sh", import.meta.url), "utf8");
  const office = readFileSync(new URL("../../server/isomux-office.ts", import.meta.url), "utf8");
  expect(entrypoint).toContain("export ISOMUX_APP_SUPERVISOR=container\n");
  expect(office).toContain('process.env.ISOMUX_APP_SUPERVISOR === "container"');
});
