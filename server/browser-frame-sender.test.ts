import { expect, test } from "bun:test";
import { BrowserFrameSender } from "./browser-frame-sender.ts";

function fixture() {
  let buffered = 0,
    allowed = true;
  const sent: (string | Uint8Array)[] = [];
  const sender = new BrowserFrameSender(
    { send: (data) => sent.push(data), getBufferedAmount: () => buffered },
    () => allowed,
  );
  return {
    sender,
    sent,
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
