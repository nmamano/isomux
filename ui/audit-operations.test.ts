import { expect, it } from "bun:test";
import { ALL_ROUTES } from "../server/routes/table.ts";
import { AUDIT_OPERATIONS } from "./audit-operations.ts";

it("offers every audited route and direct audit operation", async () => {
  const known = new Set<string>(AUDIT_OPERATIONS);
  for (const route of ALL_ROUTES) {
    if (route.method !== "GET" && route.audit?.owner !== "none")
      expect([...known]).toContain(route.opId);
  }
  const glob = new Bun.Glob("**/*.ts");
  const direct = new Set<string>();
  for await (const path of glob.scan({ cwd: `${import.meta.dir}/../server` })) {
    if (path.includes("test") || path.includes("_generated")) continue;
    const source = await Bun.file(`${import.meta.dir}/../server/${path}`).text();
    for (const match of source.matchAll(/operation:\s*"([\w.]+)"/g)) direct.add(match[1]);
  }
  expect(direct.size).toBeGreaterThan(0);
  for (const operation of direct) expect([...known]).toContain(operation);
});
