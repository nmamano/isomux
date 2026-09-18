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
const { setShim, shimEmit } = await import("../ws.ts");
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
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="contain" canDrive onClose={() => {}} />,
    );
    act(() =>
      shimEmit({
        type: "browser_frame",
        agentId: "contain",
        data: "jpeg",
        width: 800,
        height: 400,
      }),
    );
    const canvas = view.getByRole("application");
    canvas.setPointerCapture = () => {};
    for (const shape of [
      {
        width: 400,
        height: 400,
        margin: [200, 50],
        points: [
          [0, 100, 0, 0],
          [400, 100, 800, 0],
          [0, 300, 0, 400],
          [400, 300, 800, 400],
          [200, 200, 400, 200],
        ],
      },
      {
        width: 800,
        height: 200,
        margin: [50, 100],
        points: [
          [200, 0, 0, 0],
          [600, 0, 800, 0],
          [200, 200, 0, 400],
          [600, 200, 800, 400],
          [400, 100, 400, 200],
        ],
      },
    ]) {
      Object.defineProperty(canvas, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          left: 0,
          top: 0,
          width: shape.width,
          height: shape.height,
        }),
      });
      sent.length = 0;
      fireEvent.pointerDown(canvas, {
        clientX: shape.margin[0],
        clientY: shape.margin[1],
      });
      fireEvent(
        canvas,
        Object.assign(new Event("wheel", { bubbles: true }), {
          clientX: shape.margin[0],
          clientY: shape.margin[1],
          deltaY: 16,
        }),
      );
      expect(sent).toEqual([]);
      for (const [clientX, clientY, x, y] of shape.points) {
        fireEvent.pointerDown(canvas, { clientX, clientY });
        expect(sent.at(-1)).toMatchObject({ input: { kind: "mouse", x, y } });
        fireEvent(
          canvas,
          Object.assign(new Event("wheel", { bubbles: true }), {
            clientX,
            clientY,
            deltaY: 16,
          }),
        );
        expect(sent.at(-1)).toMatchObject({
          input: { event: "mouseWheel", x, y, deltaY: 16 },
        });
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
      deviceScaleFactor: 1,
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
    surface.setPointerCapture = () => {};
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
    fireEvent.pointerDown(surface, { clientX: 210, clientY: 170 });
    const escapedKeys: string[] = [];
    const officeShortcut = (event: KeyboardEvent) =>
      escapedKeys.push(event.key);
    window.addEventListener("keydown", officeShortcut);
    window.addEventListener("keyup", officeShortcut);
    try {
      for (const key of ["a", "t", "s", "Escape", "Tab", "`", "e"]) {
        fireEvent.keyDown(surface, {
          key,
          ctrlKey: key === "`" || key === "e",
        });
        fireEvent.keyUp(surface, { key });
        expect(sent.at(-2)).toMatchObject({
          type: "browser_input",
          input: { kind: "key", event: "keyDown", key },
        });
        expect(sent.at(-1)).toMatchObject({
          type: "browser_input",
          input: { kind: "key", event: "keyUp", key },
        });
      }
      expect(escapedKeys).toEqual([]);
    } finally {
      window.removeEventListener("keydown", officeShortcut);
      window.removeEventListener("keyup", officeShortcut);
    }

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
    fireEvent.pointerUp(surface, { clientX: 210, clientY: 170 });
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
      canvas.setPointerCapture = () => {};
      expect([canvas.width, canvas.height]).toEqual([400, 250]);
      Object.defineProperty(canvas, "getBoundingClientRect", {
        value: () => ({ left: 0, top: 0, width: 400, height: 250 }),
      });
      fireEvent.pointerDown(canvas, { clientX: 200, clientY: 125 });
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
    act(() =>
      shimEmit({ type: "browser_status", agentId: "retina", available: true }),
    );
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
        deviceScaleFactor: 2,
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
    setShim((command) => sent.push(command));
    const original = globalThis.ResizeObserver;
    const ratio = window.devicePixelRatio;
    let resize!: ResizeObserverCallback;
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
    const view = render(
      <BrowserPanel agentId="manager-size" canDrive onClose={() => {}} />,
    );
    const emit = (width: number) =>
      resize(
        [{ contentRect: { width, height: 700 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    try {
      act(() => {
        emit(380);
        emit(390);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      expect(
        sent.filter(
          (m) => m.type === "browser_input" && m.input.kind === "viewport",
        ),
      ).toEqual([]);
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "manager-size",
          available: true,
        }),
      );
      expect(sent.at(-1)).toEqual({
        type: "browser_input",
        agentId: "manager-size",
        input: { kind: "viewport", width: 390, height: 700 },
      });
      expect(
        sent.filter((m) => m.type === "browser_watch").at(-1),
      ).toMatchObject({ maxWidth: 784, maxHeight: 1408, deviceScaleFactor: 2 });
      // Both widths round to the same capture demand; CSS resize still reaches the page.
      act(() => emit(391));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      expect(sent.at(-1)).toEqual({
        type: "browser_input",
        agentId: "manager-size",
        input: { kind: "viewport", width: 391, height: 700 },
      });
    } finally {
      view.unmount();
      globalThis.ResizeObserver = original;
      Object.defineProperty(window, "devicePixelRatio", {
        value: ratio,
        configurable: true,
      });
    }
  });

  it("opens a page for the manager and sends navigation and close through input", () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="nav" canDrive onClose={() => {}} />,
    );
    expect(
      view.container.querySelector('[aria-live="polite"]')!.textContent.length,
    ).toBeGreaterThan(0);
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

  it("forwards held moves before a clamped release and releases on blur or cancellation", () => {
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="drag" canDrive onClose={() => {}} />,
    );
    act(() =>
      shimEmit({
        type: "browser_frame",
        agentId: "drag",
        data: "jpeg",
        width: 800,
        height: 400,
      }),
    );
    const canvas = view.getByRole("application");
    canvas.setPointerCapture = () => {};
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    sent.length = 0;
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 20,
      button: 0,
      buttons: 1,
      pointerId: 1,
    });
    fireEvent.pointerMove(canvas, {
      clientX: 500,
      clientY: 30,
      buttons: 1,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: 500,
      clientY: 30,
      button: 0,
      buttons: 0,
      pointerId: 1,
    });
    expect(sent).toMatchObject([
      { input: { event: "mousePressed", button: "left", x: 20, y: 40 } },
      { input: { event: "mouseMoved", button: "left", x: 800, y: 60 } },
      { input: { event: "mouseReleased", button: "left", x: 800, y: 60 } },
    ]);
    for (const cancel of [
      () => fireEvent.blur(window),
      () => fireEvent.pointerCancel(canvas, { pointerId: 1 }),
    ]) {
      fireEvent.pointerDown(canvas, {
        clientX: 10,
        clientY: 20,
        button: 0,
        buttons: 1,
        pointerId: 1,
      });
      cancel();
      expect(sent.at(-1)).toMatchObject({
        input: { event: "mouseReleased", button: "left" },
      });
    }
    view.unmount();
  });

  it("copies only the correlated selection and reports empty, truncated, and refused writes", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writes: string[] = [];
    let refuse = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (refuse) throw new Error("denied");
          writes.push(text);
        },
      },
    });
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="copy" canDrive onClose={() => {}} />,
    );
    try {
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "copy",
          available: true,
          busy: false,
        }),
      );
      const button = view.container.querySelector("button")!;
      act(() =>
        shimEmit({
          type: "browser_frame",
          agentId: "copy",
          data: "jpeg",
          width: 800,
          height: 600,
        }),
      );
      const status = () =>
        view.container.querySelector('[aria-live="polite"]')!.textContent;
      const start = (modifier?: "ctrlKey" | "metaKey") => {
        if (modifier) {
          fireEvent.keyDown(view.getByRole("application"), {
            key: "c",
            code: "KeyC",
            [modifier]: true,
          });
        } else fireEvent.click(button);
        const command = sent.at(-1);
        if (
          command?.type !== "browser_input" ||
          command.input.kind !== "selection"
        )
          throw new Error("missing selection request");
        return command.input.requestId;
      };
      const id = start("ctrlKey");
      await act(async () => {
        shimEmit({
          type: "browser_selection",
          agentId: "other",
          requestId: id,
          text: "wrong agent",
          truncated: false,
        });
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: id + 1,
          text: "wrong request",
          truncated: false,
        });
      });
      expect(writes).toEqual([]);
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: id,
          text: "chosen text",
          truncated: false,
        }),
      );
      expect(writes).toEqual(["chosen text"]);
      const copied = status();
      fireEvent.click(
        view.container.querySelectorAll('form button[type="button"]')[2],
      );
      expect(status() === copied).toBe(false);
      await act(async () =>
        shimEmit({
          type: "browser_status",
          agentId: "copy",
          available: true,
          busy: false,
          title: "Fixture page title",
        }),
      );
      expect(status()).toBe("Fixture page title");
      const emptyId = start();
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: emptyId,
          text: "",
          truncated: false,
        }),
      );
      expect(writes).toHaveLength(1);
      expect(status() === copied).toBe(false);
      const truncatedId = start("metaKey");
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: truncatedId,
          text: "x".repeat(20_000),
          truncated: true,
        }),
      );
      expect(writes[1]).toHaveLength(20_000);
      expect(status() === copied).toBe(false);
      const readFailedId = start();
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: readFailedId,
          text: "",
          truncated: false,
          error: "selection_failed",
        }),
      );
      expect(writes).toHaveLength(2);
      const readFailure = status();
      expect(readFailure.length).toBeGreaterThan(0);
      refuse = true;
      const failedId = start();
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "copy",
          requestId: failedId,
          text: "refused",
          truncated: false,
        }),
      );
      expect(writes).toHaveLength(2);
      expect(status() === copied).toBe(false);
      expect(status() === readFailure).toBe(false);
      expect(status().length).toBeGreaterThan(0);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      const before = sent.length;
      fireEvent.click(button);
      expect(sent).toHaveLength(before);
      expect(status().length).toBeGreaterThan(0);
    } finally {
      view.unmount();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("clears the copy note on agent navigation while the address bar is focused", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    const sent: ClientCommand[] = [];
    setShim((command) => sent.push(command));
    const view = render(
      <BrowserPanel agentId="agent-nav" canDrive onClose={() => {}} />,
    );
    const status = () =>
      view.container.querySelector('[aria-live="polite"]')!.textContent;
    const emitStatus = (url: string, title: string, busy = false) =>
      act(() =>
        shimEmit({
          type: "browser_status",
          agentId: "agent-nav",
          available: true,
          url,
          title,
          busy,
        }),
      );
    try {
      emitStatus("https://example.test/first", "First page");
      fireEvent.click(view.container.querySelector("button")!);
      const request = sent.at(-1);
      if (
        request?.type !== "browser_input" ||
        request.input.kind !== "selection"
      )
        throw new Error("missing selection request");
      const requestId = request.input.requestId;
      await act(async () =>
        shimEmit({
          type: "browser_selection",
          agentId: "agent-nav",
          requestId,
          text: "selected",
          truncated: false,
        }),
      );
      const copied = status();
      emitStatus("https://example.test/first", "First page");
      expect(status()).toBe(copied);
      const address = view.getByRole("textbox") as HTMLInputElement;
      fireEvent.focus(address);
      fireEvent.change(address, { target: { value: "unfinished address" } });
      const commandsBeforeNavigation = sent.length;
      emitStatus("https://example.test/second", "Second page", true);
      expect(status() === copied).toBe(false);
      expect(address.value).toBe("unfinished address");
      emitStatus("https://example.test/second", "Second page");
      expect(status()).toBe("Second page");
      expect(sent).toHaveLength(commandsBeforeNavigation);
    } finally {
      view.unmount();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
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
    canvas.setPointerCapture = () => {};
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
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
    function Chat({
      id,
      manager,
      enabled = true,
    }: {
      id: string;
      manager: boolean;
      enabled?: boolean;
    }) {
      useBrowserAutoOpen(id, manager, enabled, open);
      return null;
    }
    const view = render(<Chat id="active" manager />);
    act(() => shimEmit({ type: "browser_action", agentId: "background" }));
    expect(opened).toBe(0);
    act(() => shimEmit({ type: "browser_action", agentId: "active" }));
    expect(opened).toBe(1);
    view.rerender(<Chat id="active" manager enabled={false} />);
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
