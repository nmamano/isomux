// The test preload stops, after each test, the agent managers that test made
// (task 7a54c6a3). A manager made in a beforeEach or the test is stopped once,
// after the test; one made in beforeAll or at a file's top level is used by
// several tests and is never stopped by the preload. Seam: the registry that
// createAgentManager calls, with fake stops; the preload's own hooks run them.
// The cases read what the cases before them left, so they run as a whole
// file, in order (a -t filter that skips one makes the next one red).

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { registerAgentManagerStop } from "../agent-manager-stops.ts";

const stopped: string[] = [];
registerAgentManagerStop(() => stopped.push("top level"));

describe("managers the preload stops", () => {
  let n = 0;
  beforeAll(() => {
    registerAgentManagerStop(() => stopped.push("beforeAll"));
  });
  beforeEach(() => {
    n += 1;
    const label = `beforeEach ${n}`;
    registerAgentManagerStop(() => stopped.push(label));
  });

  it("first test: nothing is stopped while it runs", () => {
    registerAgentManagerStop(() => stopped.push("test 1"));
    expect(stopped).toEqual([]);
  });

  it("second test: the first test's managers are stopped, once", () => {
    expect([...stopped].sort()).toEqual(["beforeEach 1", "test 1"]);
  });

  it("third test: the second test's manager is stopped; beforeAll and top-level ones never are", () => {
    expect([...stopped].sort()).toEqual([
      "beforeEach 1",
      "beforeEach 2",
      "test 1",
    ]);
  });
});
