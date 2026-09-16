import { expect, test } from "bun:test";
import { BrowserFrameSender } from "./browser-frame-sender.ts";

function fixture() {
  let buffered = 0,
    allowed = true,
    samples = 0;
  const sent: (string | Uint8Array)[] = [];
  const sender = new BrowserFrameSender(
    {
      send: (data) => sent.push(data),
      getBufferedAmount: () => {
        samples++;
        return buffered;
      },
    },
    () => allowed,
    undefined,
    undefined,
    20,
  );
  return {
    sender,
    sent,
    samples: () => samples,
    buffer: (value: number) => {
      buffered = value;
    },
    revoke: () => {
      allowed = false;
    },
  };
}

test("a burst followed by silence delivers the latest held frame on drain", () => {
  const f = fixture();
  f.buffer(100);
  f.sender.send("old frame");
  f.sender.send("final frame");
  expect(f.sent).toEqual([]);
  f.buffer(0);
  f.sender.flush();
  expect(f.sent).toEqual(["final frame"]);
  f.sender.flush();
  expect(f.sent).toHaveLength(1);
});

test("a slow socket does not delay a different watcher", () => {
  const slow = fixture(),
    fast = fixture();
  slow.buffer(100);
  slow.sender.send("frame");
  fast.sender.send("frame");
  expect(slow.sent).toEqual([]);
  expect(fast.sent).toEqual(["frame"]);
  slow.sender.stop();
  fast.sender.stop();
});

test("access lost while buffered prevents delivery after drain", () => {
  const f = fixture();
  f.buffer(100);
  f.sender.send("private frame");
  f.revoke();
  f.buffer(0);
  f.sender.flush();
  expect(f.sent).toEqual([]);
});

test("unsubscribe discards the held frame", () => {
  const f = fixture();
  f.buffer(100);
  f.sender.send("frame");
  f.sender.stop();
  f.buffer(0);
  f.sender.flush();
  f.sender.send("later");
  expect(f.sent).toEqual([]);
});

test("held frames recover without drain, clear stops sampling, and revoked access blocks delivery", async () => {
  const f = fixture();
  try {
    f.buffer(100);
    f.sender.send("old");
    f.sender.send("latest");
    await Bun.sleep(80);
    expect(f.sent).toEqual([]);
    f.buffer(0);
    await Bun.sleep(80);
    expect(f.sent).toEqual(["latest"]);
    f.buffer(100);
    f.sender.send("cleared");
    f.sender.clear();
    f.buffer(0);
    const samplesAfterClear = f.samples();
    await Bun.sleep(80);
    expect(f.samples()).toBe(samplesAfterClear);
    expect(f.sent).toEqual(["latest"]);
    f.buffer(100);
    f.sender.send("revoked");
    f.revoke();
    f.buffer(0);
    await Bun.sleep(80);
    expect(f.sent).toEqual(["latest"]);
  } finally {
    f.sender.stop();
  }
});
