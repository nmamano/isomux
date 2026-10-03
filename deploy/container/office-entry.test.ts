import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// deploy/container/office.ts is an entry script with top-level side effects,
// so its wiring is checked in its source. Every container deployment sits
// behind a load balancer (internal-docs/proxy-trust-design.md).
test("the container entry declares its load balancer for the office and the setup form", () => {
  const office = readFileSync(new URL("./office.ts", import.meta.url), "utf8");
  // The office reads this from office-config.json at boot.
  expect(office).toMatch(
    /atomicWriteFileSync\([\s\S]*trustedProxy: "load-balancer"[\s\S]*\);/,
  );
  // The setup form keys its limit on the client behind the load balancer.
  expect(office).toMatch(
    /classifyRequest\(\s*req,[\s\S]*?"load-balancer",?\s*\)\.client/,
  );
});
