// The test preload pins TZ to the zone the process starts in (task 6ad9d006).
// bun test starts with TZ unset, and a file that restored an unset TZ with
// `delete` moved every later file in the process to the system zone, so a
// formatter or a local date built by a later file disagreed with one cached
// before it.

import { expect, it } from "bun:test";

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

it("pins TZ, so a file that restores TZ keeps the process zone", () => {
  const before = zone();
  expect(process.env.TZ).toBe(before);

  const saved = process.env.TZ;
  process.env.TZ = before === "Asia/Tokyo" ? "Europe/Madrid" : "Asia/Tokyo";
  expect(zone()).not.toBe(before);
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;

  expect(zone()).toBe(before);
});
