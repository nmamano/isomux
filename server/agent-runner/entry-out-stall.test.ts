// The stall bound of a runner entry's output stream (client.ts
// runRunnerEntryOut, slice 3c of task b94dfd25): a member's backup ends when
// their runner sends nothing for stallMs. The properties:
// - a runner that goes quiet ends the stream with an error, and its socket
//   is closed;
// - the office's own wait (a paused stream, the office not reading) is not
//   the runner's stall.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunnerEntryOut } from "./client.ts";
import { encodeData, encodeJson, FRAME_STDOUT } from "./frames.ts";

let dir = "";
let fake: Server | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entry-out-stall-"));
});
afterEach(() => {
  fake?.close();
  fake = null;
  rmSync(dir, { recursive: true, force: true });
});

async function fakeRunner(
  serve: (send: (frame: Buffer | Buffer[]) => void, end: () => void) => void,
): Promise<{ socketPath: string; closed: () => boolean }> {
  let closed = false;
  const socketPath = join(dir, "runner.sock");
  fake = createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
    socket.on("close", () => {
      closed = true;
    });
    serve(
      (frame) => {
        for (const f of [frame].flat()) socket.write(f);
      },
      () => socket.end(),
    );
  });
  await new Promise<void>((resolve) => fake!.listen(socketPath, resolve));
  return { socketPath, closed: () => closed };
}

const exit = () => encodeJson({ type: "exit", code: 0, signal: null });

async function drain(
  stream: AsyncIterable<Uint8Array>,
  before?: () => Promise<void>,
): Promise<{ bytes: number; error: string | null }> {
  let bytes = 0;
  try {
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    if (!first.done) bytes += first.value.length;
    await before?.();
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      bytes += next.value.length;
    }
    return { bytes, error: null };
  } catch (error) {
    return { bytes, error: (error as Error).message };
  }
}

describe("a runner entry's output", () => {
  it("ends with an error when the runner sends nothing for the stall bound, and closes its socket", async () => {
    const runner = await fakeRunner((send) => {
      send(encodeData(FRAME_STDOUT, Buffer.from("one")));
      // Then nothing, and no end.
    });
    const started = Date.now();
    const result = await Promise.race([
      drain(
        runRunnerEntryOut(runner.socketPath, "backup-list", {}, 10_000, 200),
      ),
      Bun.sleep(2000).then(() => ({ bytes: -1, error: "still open" })),
    ]);
    const took = Date.now() - started;
    const deadline = Date.now() + 1000;
    while (!runner.closed() && Date.now() < deadline) await Bun.sleep(10);
    expect({
      bytes: result.bytes,
      stalled: /nothing for/.test(result.error ?? ""),
      soon: took < 2000,
      closed: runner.closed(),
    }).toEqual({ bytes: 3, stalled: true, soon: true, closed: true });
  });

  // MUTANT: the stall timer runs on while the stream is paused.
  it("does not count the office's own wait on a paused stream as a stall", async () => {
    const frames = 100;
    const runner = await fakeRunner((send, end) => {
      for (let i = 0; i < frames; i++)
        send(encodeData(FRAME_STDOUT, Buffer.alloc(1000, 1)));
      send(exit());
      end();
    });
    const result = await drain(
      runRunnerEntryOut(runner.socketPath, "backup-files", {}, 10_000, 200),
      // The office reads one chunk, then waits longer than the bound.
      () => Bun.sleep(600),
    );
    expect(result).toEqual({ bytes: frames * 1000, error: null });
  });
});
