import { expect, it } from "bun:test";
import { createOpenCodeTestReaper } from "./opencode-test-reaper.ts";

it("sweeps a server restarted by a timed-out body after per-test cleanup", async () => {
  const reaper = createOpenCodeTestReaper();
  let running = true;
  const supervisor = { shutdown: async () => { running = false; } };
  reaper.track(supervisor);
  reaper.add(() => supervisor.shutdown());
  await reaper.afterEach();
  expect(running).toBe(false);
  running = true;
  await reaper.afterAll();
  expect(running).toBe(false);
});

it("runs late finally cleanup again but does not repeat it in afterEach", async () => {
  const reaper = createOpenCodeTestReaper();
  let stops = 0;
  const teardown = reaper.add(async () => { stops++; });
  await reaper.afterEach();
  expect(stops).toBe(1);
  await teardown();
  expect(stops).toBe(2);
  await reaper.afterEach();
  expect(stops).toBe(2);
});
