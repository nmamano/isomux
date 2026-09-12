import { expect, test } from "bun:test";
import { BrowserStreamPressure } from "./browser-stream-pressure.ts";
import { BrowserFrameSender } from "./browser-frame-sender.ts";

test("sustained pressure lowers quality before size; recovery is slower and the middle band cannot oscillate", () => {
  const pressure = new BrowserStreamPressure();
  pressure.sample(101, 100, 0);
  expect(pressure.sample(101, 100, 1999)).toBe(false);
  for (let rung = 1; rung <= 4; rung++) {
    expect(pressure.sample(101, 100, rung * 2000)).toBe(true);
    expect(pressure.level).toBe(rung);
  }
  for (let time = 10000; time <= 30000; time += 250)
    pressure.sample(100, 100, time);
  expect(pressure.level).toBe(4);
  pressure.sample(25, 100, 31000);
  expect(pressure.sample(25, 100, 38999)).toBe(false);
  expect(pressure.sample(25, 100, 39000)).toBe(true);
  expect(pressure.level).toBe(3);
  // A short pressure pulse cancels recovery dwell.
  pressure.sample(101, 100, 40000);
  pressure.sample(0, 100, 41000);
  pressure.sample(0, 100, 48999);
  expect(pressure.level).toBe(3);
  for (let time = 49000; time <= 65000; time += 8000)
    pressure.sample(0, 100, time);
  expect(pressure.level).toBe(0);
});

test("resize sender replacement preserves pressure dwell and stop cancels callbacks and held bytes", () => {
  let buffered = 1000,
    changes = 0;
  const sent: (string | Uint8Array)[] = [];
  const socket = {
    send: (data: string | Uint8Array) => sent.push(data),
    getBufferedAmount: () => buffered,
  };
  const first = new BrowserFrameSender(
    socket,
    () => true,
    () => changes++,
  );
  first.send(new Uint8Array(100));
  first.samplePressure(0);
  first.samplePressure(2000);
  first.stop();
  const resized = new BrowserFrameSender(
    socket,
    () => true,
    () => changes++,
    first.pressure,
  );
  try {
    resized.send(new Uint8Array(80));
    resized.samplePressure(4000);
    expect(resized.pressure.level).toBe(2);
    expect(changes).toBe(2);
    resized.clear();
    buffered = 0;
    resized.flush();
    expect(sent).toEqual([]);
    resized.stop();
    resized.samplePressure(50000);
    expect(changes).toBe(2);
  } finally {
    resized.stop();
  }
});
