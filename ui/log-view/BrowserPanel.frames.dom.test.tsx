import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { setShim, shimEmit, shimEmitBinary } = await import("../ws.ts");
const { BrowserPanel } = await import("./BrowserPanel.tsx");
import type { ClientCommand } from "../../shared/types.ts";

afterAll(() =>
  setShim(
    () => {},
    () => {},
  ),
);

const bitmapDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "createImageBitmap",
);
const resizeDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "ResizeObserver",
);
// Existing Image tests also exercise subscribe-time compatibility. Binary
// tests supply their own deferred decoder.
beforeEach(() => {
  Reflect.deleteProperty(globalThis, "createImageBitmap");
});
afterEach(() => {
  if (bitmapDescriptor)
    Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
  if (resizeDescriptor)
    Object.defineProperty(globalThis, "ResizeObserver", resizeDescriptor);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

it("binary decode owns one active bitmap and one pending frame, rejects stale epochs and closes on every resolution", async () => {
  const { encodeBrowserFrame } = await import("../../shared/browser-frame.ts");
  let onResize!: ResizeObserverCallback;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      onResize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const jobs: Array<{
    blob: Blob;
    resolve: (bitmap: ImageBitmap) => void;
    reject: () => void;
  }> = [];
  globalThis.createImageBitmap = ((blob: Blob) =>
    new Promise<ImageBitmap>((resolve, reject) =>
      jobs.push({ blob, resolve, reject: () => reject(new Error("decode")) }),
    )) as typeof createImageBitmap;
  const sent: ClientCommand[] = [];
  setShim((command) => sent.push(command));
  const view = render(<BrowserPanel agentId="binary" onClose={() => {}} />);
  const current = () =>
    (
      sent
        .filter((m) => m.type === "browser_watch" && m.watching)
        .at(-1) as Extract<ClientCommand, { type: "browser_watch" }>
    ).generation!;
  const emit = (byte: number, generation = current(), agentId = "binary") =>
    act(() =>
      shimEmitBinary(
        encodeBrowserFrame({
          agentId,
          generation,
          width: 1280,
          height: 800,
          jpeg: new Uint8Array([255, 216, byte, 255, 217]),
        }).buffer,
      ),
    );
  let closes = 0,
    paints = 0,
    throwDraw = false;
  const canvas = view.container.querySelector("canvas")!;
  Object.defineProperty(canvas, "getContext", {
    value: () => ({
      drawImage() {
        if (throwDraw) throw new Error("draw");
        paints++;
      },
    }),
  });
  const resolve = async (index: number) =>
    act(async () => {
      jobs[index].resolve({
        width: 640,
        height: 400,
        close() {
          closes++;
        },
      });
      await Promise.resolve();
    });
  try {
    expect(sent[0]).toMatchObject({
      transport: "jpeg-v1",
      generation: current(),
    });
    emit(1, current(), "other");
    emit(1, current() + 1);
    expect(jobs).toHaveLength(0);
    emit(1);
    emit(2);
    emit(3); // only 1 decodes; 3 replaces pending 2
    expect(jobs).toHaveLength(1);
    await resolve(0);
    expect(jobs).toHaveLength(2);
    expect(new Uint8Array(await jobs[1].blob.arrayBuffer())[2]).toBe(3);
    expect(paints).toBe(1);
    expect(closes).toBe(1);
    await resolve(1);
    expect(paints).toBe(2);
    expect(closes).toBe(2);
    emit(4);
    const old = current();
    await act(async () => {
      onResize(
        [{ contentRect: { width: 400, height: 240 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      await new Promise((resolve) => setTimeout(resolve, 170));
    });
    expect(current()).toBeGreaterThan(old);
    emit(5, old);
    await resolve(2);
    expect(jobs).toHaveLength(3);
    expect(paints).toBe(2);
    expect(closes).toBe(3);
    emit(6);
    act(() =>
      shimEmit({ type: "browser_status", agentId: "binary", available: false }),
    );
    emit(7); // current watch id, but unavailable decode epoch
    await resolve(3);
    expect(jobs).toHaveLength(4);
    expect(paints).toBe(2);
    expect(closes).toBe(4);
    act(() =>
      shimEmit({ type: "browser_status", agentId: "binary", available: true }),
    );
    throwDraw = true;
    emit(8);
    await resolve(4);
    throwDraw = false;
    expect(closes).toBe(5);
    expect(paints).toBe(2);
    emit(9);
    view.unmount();
    await resolve(5);
    expect(closes).toBe(6);
    expect(paints).toBe(2);
  } finally {
    view.unmount();
  }
});

it("three consecutive bitmap rejections select JSON once; late binary frames are ignored", async () => {
  const { encodeBrowserFrame } = await import("../../shared/browser-frame.ts");
  globalThis.createImageBitmap = () =>
    Promise.reject(new Error("unsupported JPEG"));
  const sent: ClientCommand[] = [];
  setShim((command) => sent.push(command));
  const view = render(<BrowserPanel agentId="fallback" onClose={() => {}} />);
  const first = sent[0] as Extract<ClientCommand, { type: "browser_watch" }>;
  const frame = encodeBrowserFrame({
    agentId: "fallback",
    generation: first.generation!,
    width: 800,
    height: 600,
    jpeg: new Uint8Array([255, 216, 255, 217]),
  });
  try {
    for (let i = 0; i < 3; i++)
      await act(async () => {
        shimEmitBinary(frame.buffer);
        await Promise.resolve();
      });
    const watches = sent.filter((m) => m.type === "browser_watch");
    expect(watches).toHaveLength(2);
    expect(watches[1]).toEqual({
      type: "browser_watch",
      agentId: "fallback",
      watching: true,
      deviceScaleFactor: 1,
    });
    await act(async () => {
      shimEmitBinary(frame.buffer);
      await Promise.resolve();
    });
    expect(sent.filter((m) => m.type === "browser_watch")).toHaveLength(2);
    act(() =>
      shimEmit({
        type: "browser_frame",
        agentId: "fallback",
        data: "jpeg",
        width: 800,
        height: 600,
      }),
    );
    expect(view.getByRole("application") !== null).toBe(true);
  } finally {
    view.unmount();
  }
});

it("two viewport barriers reject old in-flight binary paints for managers and room viewers", async () => {
  const { encodeBrowserFrame } = await import("../../shared/browser-frame.ts");
  for (const canDrive of [true, false]) {
    const jobs: Array<(bitmap: ImageBitmap) => void> = [];
    globalThis.createImageBitmap = () =>
      new Promise<ImageBitmap>((resolve) => jobs.push(resolve));
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="barrier" canDrive={canDrive} onClose={() => {}} />,
    );
    const watch = sent.find((m) => m.type === "browser_watch") as Extract<
      ClientCommand,
      { type: "browser_watch" }
    >;
    let paints = 0,
      closed = 0;
    const canvas = view.container.querySelector("canvas")!;
    Object.defineProperty(canvas, "getContext", {
      value: () => ({
        drawImage() {
          paints++;
        },
      }),
    });
    const status = (resizing = false) =>
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "barrier",
          available: true,
          resizing,
        }),
      );
    const emit = () =>
      act(() =>
        shimEmitBinary(
          encodeBrowserFrame({
            agentId: "barrier",
            generation: watch.generation!,
            width: 1280,
            height: 800,
            jpeg: new Uint8Array([255, 216, 1, 255, 217]),
          }).buffer,
        ),
      );
    const resolve = async (index: number) =>
      act(async () => {
        jobs[index]({
          width: 640,
          height: 400,
          close() {
            closed++;
          },
        });
        await Promise.resolve();
      });
    try {
      status();
      for (let round = 0; round < 2; round++) {
        emit(); // decode has started before this viewport barrier
        emit(); // old pending frame must also be discarded
        status(true);
        emit(); // frame during resize must be refused
        status(false);
        await resolve(round * 2);
        expect(paints).toBe(round); // removing barrier epoch invalidation paints the old image
        expect(jobs).toHaveLength(round * 2 + 1);
        emit();
        await resolve(round * 2 + 1);
        expect(paints).toBe(round + 1);
      }
      expect(closed).toBe(4);
      expect(
        sent.filter(
          (m) => m.type === "browser_input" && m.input.kind === "viewport",
        ),
      ).toEqual([]);
    } finally {
      view.unmount();
    }
  }
});

it("updates DPR without a CSS resize, including when physical bounds are capped", async () => {
  const sent: ClientCommand[] = [];
  setShim((command) => sent.push(command));
  const originalObserver = globalThis.ResizeObserver;
  const originalRatio = window.devicePixelRatio;
  const originalMatchMedia = window.matchMedia;
  let resize!: ResizeObserverCallback;
  let mediaChanged!: () => void;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = (() => ({
    addEventListener: (_type: string, fn: () => void) => {
      mediaChanged = fn;
    },
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "devicePixelRatio", {
    value: 2,
    configurable: true,
  });
  const view = render(
    <BrowserPanel agentId="dpr-change" canDrive onClose={() => {}} />,
  );
  try {
    act(() =>
      resize(
        [{ contentRect: { width: 1600, height: 1600 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    await act(async () => {
      await Bun.sleep(170);
    });
    const before = sent.filter((m) => m.type === "browser_watch").at(-1);
    expect(before).toMatchObject({
      maxWidth: 2560,
      maxHeight: 2560,
      deviceScaleFactor: 2,
    });
    Object.defineProperty(window, "devicePixelRatio", {
      value: 3,
      configurable: true,
    });
    act(() => mediaChanged());
    await act(async () => {
      await Bun.sleep(170);
    });
    expect(sent.filter((m) => m.type === "browser_watch").at(-1)).toMatchObject(
      { maxWidth: 2560, maxHeight: 2560, deviceScaleFactor: 3 },
    );
  } finally {
    view.unmount();
    globalThis.ResizeObserver = originalObserver;
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window, "devicePixelRatio", {
      value: originalRatio,
      configurable: true,
    });
  }
});
