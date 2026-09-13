import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { setShim, shimEmit, shimEmitBinary } = await import("../ws.ts");
const { BrowserPanel, useBrowserAutoOpen } = await import("./BrowserPanel.tsx");
import type { ClientCommand } from "../../shared/types.ts";

afterAll(() =>
  setShim(
    () => {},
    () => {},
  ),
);

describe("BrowserPanel", () => {
  it("maps input through the contained image and ignores the margins", () => {
    const sent: ClientCommand[] = [];
    setShim(command => sent.push(command));
    const view = render(<BrowserPanel agentId="contain" canDrive onClose={() => {}} />);
    act(() => shimEmit({ type: "browser_frame", agentId: "contain", data: "jpeg", width: 800, height: 400 }));
    const canvas = view.getByRole("application");
    for (const shape of [
      { width: 400, height: 400, margin: [200, 50], points: [[0,100,0,0], [400,100,800,0], [0,300,0,400], [400,300,800,400], [200,200,400,200]] },
      { width: 800, height: 200, margin: [50, 100], points: [[200,0,0,0], [600,0,800,0], [200,200,0,400], [600,200,800,400], [400,100,400,200]] },
    ]) {
      Object.defineProperty(canvas, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, width: shape.width, height: shape.height }) });
      sent.length = 0;
      fireEvent.mouseDown(canvas, { clientX: shape.margin[0], clientY: shape.margin[1] });
      fireEvent(canvas, Object.assign(new Event("wheel", { bubbles: true }), { clientX: shape.margin[0], clientY: shape.margin[1], deltaY: 16 }));
      expect(sent).toEqual([]);
      for (const [clientX, clientY, x, y] of shape.points) {
        fireEvent.mouseDown(canvas, { clientX, clientY });
        expect(sent.at(-1)).toMatchObject({ input: { kind: "mouse", x, y } });
        fireEvent(canvas, Object.assign(new Event("wheel", { bubbles: true }), { clientX, clientY, deltaY: 16 }));
        expect(sent.at(-1)).toMatchObject({ input: { event: "mouseWheel", x, y, deltaY: 16 } });
      }
    }
    view.unmount();
  });

  it("subscribes, paints frames, and forwards pointer and keyboard input", () => {
    const sent: ClientCommand[] = [];
    setShim(
      (command) => sent.push(command),
      () => {},
    );
    const view = render(
      <BrowserPanel agentId="agent-1" canDrive onClose={() => {}} />,
    );
    expect(sent[0]).toEqual({
      type: "browser_watch",
      agentId: "agent-1",
      watching: true,
    });
    expect(view.getAllByText("Loading…").length > 0).toBe(true);

    act(() => {
      shimEmit({
        type: "browser_frame",
        agentId: "agent-1",
        data: "jpeg",
        width: 800,
        height: 600,
      });
    });
    const surface = view.getByRole("application");
    Object.defineProperty(surface, "getBoundingClientRect", {
      value: () => ({
        left: 10,
        top: 20,
        width: 400,
        height: 300,
        right: 410,
        bottom: 320,
        x: 10,
        y: 20,
        toJSON() {},
      }),
    });
    fireEvent.mouseDown(surface, { clientX: 210, clientY: 170 });
    fireEvent.keyDown(surface, { key: "a", code: "KeyA" });

    expect(
      sent.some(
        (command) =>
          command.type === "browser_input" &&
          command.input.kind === "mouse" &&
          command.input.x === 400 &&
          command.input.y === 300,
      ),
    ).toBe(true);
    expect(
      sent.some(
        (command) =>
          command.type === "browser_input" &&
          command.input.kind === "key" &&
          command.input.text === "a",
      ),
    ).toBe(true);
    view.unmount();
    expect(sent.at(-1)).toEqual({
      type: "browser_watch",
      agentId: "agent-1",
      watching: false,
    });
  });
  it("drops pending stale frames and draws at decoded size with page coordinates", () => {
    const OriginalImage = globalThis.Image;
    const images: Array<{
      src: string;
      naturalWidth: number;
      naturalHeight: number;
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    globalThis.Image = class {
      src = "";
      naturalWidth = 400;
      naturalHeight = 250;
      onload = null;
      onerror = null;
      constructor() {
        images.push(this);
      }
    } as unknown as typeof Image;
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="decode" canDrive onClose={() => {}} />,
    );
    const frame = (data: string) =>
      act(() =>
        shimEmit({
          type: "browser_frame",
          agentId: "decode",
          data,
          width: 1280,
          height: 800,
        }),
      );
    try {
      frame("first");
      frame("old");
      frame("latest");
      expect(images).toHaveLength(1);
      act(() => images[0].onload?.());
      expect(images).toHaveLength(2);
      expect(images[1].src).toBe("data:image/jpeg;base64,latest");
      const canvas = view.getByRole("application") as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([400, 250]);
      Object.defineProperty(canvas, "getBoundingClientRect", {
        value: () => ({ left: 0, top: 0, width: 400, height: 250 }),
      });
      fireEvent.mouseDown(canvas, { clientX: 200, clientY: 125 });
      expect(sent).toContainEqual({
        type: "browser_input",
        agentId: "decode",
        input: {
          kind: "mouse",
          event: "mousePressed",
          x: 640,
          y: 400,
          button: "left",
          clickCount: 1,
        },
      });
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "decode",
          available: false,
        }),
      );
      act(() => images[1].onload?.());
      expect(canvas.style.display).toBe("none");
    } finally {
      view.unmount();
      globalThis.Image = OriginalImage;
    }
  });

  it("requests device pixels and debounces quantized capture bounds", async () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const originalObserver = globalThis.ResizeObserver;
    const originalRatio = window.devicePixelRatio;
    let resize: ResizeObserverCallback = () => {};
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
    const view = render(<BrowserPanel agentId="retina" onClose={() => {}} />);
    act(() => shimEmit({ type: "browser_status", agentId: "retina", available: true }));
    const emit = (width: number) =>
      resize(
        [{ contentRect: { width, height: 240 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    try {
      act(() => {
        emit(390);
        emit(400);
      });
      expect(sent.filter((m) => m.type === "browser_watch")).toHaveLength(1);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      expect(sent.at(-1)).toEqual({
        type: "browser_watch",
        agentId: "retina",
        watching: true,
        maxWidth: 800,
        maxHeight: 480,
      });
      const count = sent.length;
      act(() => emit(399));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      expect(sent.length).toBe(count);
    } finally {
      view.unmount();
      globalThis.ResizeObserver = originalObserver;
      Object.defineProperty(window, "devicePixelRatio", {
        value: originalRatio,
        configurable: true,
      });
    }
  });

  it("debounces manager CSS viewport changes separately from device-pixel capture", async () => {
    const sent: ClientCommand[] = [];
    setShim(command => sent.push(command));
    const original = globalThis.ResizeObserver;
    const ratio = window.devicePixelRatio;
    let resize!: ResizeObserverCallback;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {} unobserve() {} disconnect() {}
    };
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const view = render(<BrowserPanel agentId="manager-size" canDrive onClose={() => {}} />);
    const emit = (width: number) => resize(
      [{ contentRect: { width, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
    try {
      act(() => { emit(380); emit(390); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      expect(sent.filter(m => m.type === "browser_input" && m.input.kind === "viewport")).toEqual([]);
      act(() => shimEmit({ type: "browser_status", agentId: "manager-size", available: true }));
      expect(sent.at(-1)).toEqual({ type: "browser_input", agentId: "manager-size",
        input: { kind: "viewport", width: 390, height: 700 } });
      expect(sent.filter(m => m.type === "browser_watch").at(-1)).toMatchObject({ maxWidth: 784, maxHeight: 1408 });
      // Both widths round to the same capture demand; CSS resize still reaches the page.
      act(() => emit(391));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      expect(sent.at(-1)).toEqual({ type: "browser_input", agentId: "manager-size",
        input: { kind: "viewport", width: 391, height: 700 } });
    } finally {
      view.unmount(); globalThis.ResizeObserver = original;
      Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    }
  });

  it("opens a page for the manager and sends navigation and close through input", () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="nav" canDrive onClose={() => {}} />,
    );
    const commands = () =>
      sent.filter((m) => m.type === "browser_input").map((m) => m.input);
    expect(commands()).toContainEqual({ kind: "navigate", action: "open" });
    const ready = () =>
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "nav",
          available: true,
          url: "https://example.test",
          title: "Example",
          busy: false,
        }),
      );
    ready();
    fireEvent.change(view.getByRole("textbox", { name: "Address" }), {
      target: { value: "example.test/next" },
    });
    fireEvent.submit(
      view.getByRole("textbox", { name: "Address" }).closest("form")!,
    );
    expect(commands()).toContainEqual({
      kind: "navigate",
      action: "goto",
      url: "https://example.test/next",
    });
    for (const [name, action] of [
      ["Back", "back"],
      ["Forward", "forward"],
      ["Reload", "reload"],
      ["Close page", "close"],
    ] as const) {
      ready();
      fireEvent.click(view.getByRole("button", { name }));
      expect(commands()).toContainEqual({ kind: "navigate", action });
    }
    act(() =>
      shimEmit({
        type: "browser_status",
        agentId: "nav",
        available: false,
        busy: false,
        url: "",
        title: "",
      }),
    );
    expect(view.getByText("No page is open.")).toBeTruthy();
    expect(
      commands().filter((m) => m.kind === "navigate" && m.action === "open"),
    ).toHaveLength(1);
    view.unmount();
  });

  it("room viewers subscribe without opening or driving the page", () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(<BrowserPanel agentId="view" onClose={() => {}} />);
    act(() =>
      shimEmit({
        type: "browser_frame",
        agentId: "view",
        data: "jpeg",
        width: 800,
        height: 600,
      }),
    );
    const canvas = view.getByRole("application");
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(canvas, { key: "a" });
    fireEvent.keyUp(canvas, { key: "a" });
    fireEvent.wheel(canvas, { deltaY: 20 });
    expect(sent.filter((m) => m.type === "browser_input")).toEqual([]);
    expect(view.queryByRole("button", { name: "Close page" })).toBeNull();
    expect(
      (view.getByRole("textbox", { name: "Address" }) as HTMLInputElement)
        .readOnly,
    ).toBe(true);
    view.unmount();
  });

  it("auto-opens only the mounted manager chat", () => {
    let opened = 0;
    const open = () => opened++;
    function Chat({ id, manager }: { id: string; manager: boolean }) {
      useBrowserAutoOpen(id, manager, open);
      return null;
    }
    const view = render(<Chat id="active" manager />);
    act(() => shimEmit({ type: "browser_action", agentId: "background" }));
    expect(opened).toBe(0);
    act(() => shimEmit({ type: "browser_action", agentId: "active" }));
    expect(opened).toBe(1);
    view.rerender(<Chat id="active" manager={false} />);
    act(() => shimEmit({ type: "browser_action", agentId: "active" }));
    expect(opened).toBe(1);
    view.unmount();
    act(() => shimEmit({ type: "browser_action", agentId: "active" }));
    expect(opened).toBe(1);
  });
});

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
    globalThis.createImageBitmap = () => new Promise<ImageBitmap>(resolve => jobs.push(resolve));
    const sent: ClientCommand[] = [];
    setShim(command => sent.push(command));
    const view = render(<BrowserPanel agentId="barrier" canDrive={canDrive} onClose={() => {}} />);
    const watch = sent.find(m => m.type === "browser_watch") as Extract<ClientCommand, { type: "browser_watch" }>;
    let paints = 0, closed = 0;
    const canvas = view.container.querySelector("canvas")!;
    Object.defineProperty(canvas, "getContext", { value: () => ({ drawImage() { paints++; } }) });
    const status = (resizing = false) => act(() => shimEmit({ type: "browser_status", agentId: "barrier", available: true, resizing }));
    const emit = () => act(() => shimEmitBinary(encodeBrowserFrame({ agentId: "barrier", generation: watch.generation!, width: 1280, height: 800, jpeg: new Uint8Array([255, 216, 1, 255, 217]) }).buffer));
    const resolve = async (index: number) => act(async () => {
      jobs[index]({ width: 640, height: 400, close() { closed++; } });
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
      expect(sent.filter(m => m.type === "browser_input" && m.input.kind === "viewport")).toEqual([]);
    } finally { view.unmount(); }
  }
});
