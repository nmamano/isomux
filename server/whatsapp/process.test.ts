// The real bridge child glue (task d03a61d8): a stdout line becomes an event,
// a bad line is dropped, and the exit comes after the events. A listener that
// throws must not stop the others or end the office server: these listeners
// run from the child's stream and exit, where a throw is an uncaught error
// and Bun ends the process on it.

import { describe, expect, it } from "bun:test";
import { tmpdir } from "os";
import { spawnBridge } from "./process.ts";
import type { BridgeEvent } from "./protocol.ts";

const CHILD = [
  'process.stdout.write(JSON.stringify({ ev: "open" }) + "\\n");',
  'process.stdout.write("not an event\\n");',
  'process.stdout.write(JSON.stringify({ ev: "closed", statusCode: 401 }) + "\\n");',
  "process.exit(3);",
].join("\n");

describe("spawnBridge", () => {
  it("delivers each event, drops a bad line, reports the exit last, and isolates a listener that throws", async () => {
    const child = spawnBridge({
      argv: [process.execPath, "-e", CHILD],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin" },
    });
    const seen: (BridgeEvent | { exit: number | null })[] = [];
    child.onEvent(() => {
      throw new Error("a listener failed");
    });
    child.onEvent((event) => seen.push(event));
    const exited = new Promise<void>((resolve) => {
      child.onExit(() => {
        throw new Error("a listener failed");
      });
      child.onExit((code) => {
        seen.push({ exit: code });
        resolve();
      });
    });
    await exited;
    // An uncaught error from the throwing listeners would land here.
    await Bun.sleep(20);
    expect(seen).toEqual([
      { ev: "open" },
      { ev: "closed", statusCode: 401 },
      { exit: 3 },
    ]);
  });
});
