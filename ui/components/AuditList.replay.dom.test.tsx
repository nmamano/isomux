// Replaying a terminal recording from the audit log (task 749cb7fd, slice c).
// A row of a recorded terminal session has a replay button; the replay plays
// the recording in a terminal that nothing in the recording can act through:
// no clipboard write (OSC 52), no window it opens (OSC 8 links).
//
// Contract with the replay view: it opens playing at 1x, and its play/pause
// toggle is the dialog's button with aria-pressed (true while playing).
import { afterAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act, waitFor } =
  await import("@testing-library/react");
const { AuditPane } = await import("./AuditList.tsx");
const { setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));

const RECORDING = "tr-0123456789abcdef";

const row = (sequence: number, terminalRecording?: { id: string }) => ({
  sequence,
  time: sequence,
  actor: { kind: "member", id: "u", name: "Member" },
  operation: "terminal.open",
  targets: ["agent-1"],
  fields: [],
  ...(terminalRecording ? { terminalRecording } : {}),
});

// What the recording holds: two lines of output 0.3 s apart, a clipboard
// write and a link between them.
const cast = [
  JSON.stringify({
    version: 2,
    width: 80,
    height: 24,
    timestamp: 1_700_000_000,
    isomux: {
      agentId: "agent-1",
      recordingId: RECORDING,
      startedBy: { kind: "member", id: "u", name: "Member" },
      notice: "panel",
    },
  }),
  JSON.stringify([0, "o", "first-line\r\n"]),
  JSON.stringify([
    0.01,
    "o",
    "\x1b]52;c;aGVsbG8=\x07\x1b]8;;https://example.test/\x07a link\x1b]8;;\x07\r\n",
  ]),
  JSON.stringify([0.3, "o", "second-line\r\n"]),
  JSON.stringify([0.3, "x", "end"]),
].join("\n");

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

it("replays a recorded session that cannot write the clipboard or open a page, and pauses", async () => {
  setApiShim(async () => ({
    items: [row(2, { id: RECORDING }), row(1)],
    nextBefore: null,
  }));
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    fetched.push(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    return new Response(cast, {
      headers: { "Content-Type": "application/x-asciicast" },
    });
  }) as unknown as typeof fetch;
  const writeText = mock(async () => {});
  const write = mock(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText, write },
    configurable: true,
  });
  const realOpen = window.open;
  const open = mock(() => null);
  window.open = open;
  try {
    const view = render(<AuditPane />);
    await act(async () => {});
    const [recorded, plain] = [...view.container.querySelectorAll("li")];
    expect(plain.querySelectorAll("button")).toHaveLength(0);
    const replay = recorded.querySelectorAll("button");
    expect(replay).toHaveLength(1);

    fireEvent.click(replay[0]);
    // The player's module (xterm) loads with the first replay.
    const dialog = await waitFor(() => view.getByRole("dialog"), {
      interval: 10,
    });
    // xterm draws a space inside a link as a no-break space.
    const screen = () =>
      (dialog.querySelector(".xterm-rows")?.textContent ?? "").replace(
        /\u00a0/g,
        " ",
      );
    // Playback starts once the player is in: wait for the first two frames
    // (10 ms apart), which leaves the 290 ms before the third to check and
    // pause.
    await waitFor(
      () => {
        expect(screen()).toContain("first-line");
        expect(screen()).toContain("a link");
      },
      { interval: 10 },
    );
    expect(
      fetched.some((url) =>
        url.endsWith(`/api/terminal-recordings/${RECORDING}`),
      ),
    ).toBe(true);
    expect(screen()).not.toContain("second-line");

    const toggle = dialog.querySelector("button[aria-pressed]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await wait(450);
    expect(screen()).not.toContain("second-line");
    fireEvent.click(toggle);
    await wait(450);
    expect(screen()).toContain("second-line");

    expect(writeText).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    globalThis.fetch = realFetch;
    window.open = realOpen;
  }
});

it("turns Record terminals on with the version of a fresh read, once the switch has read the setting", async () => {
  let release!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let version = "v1";
  const puts: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (path === "/api/office/settings" && method === "GET") {
      if (reads++ === 0) await firstRead;
      return { prompt: null, name: null, version, recordTerminals: false };
    }
    if (path === "/api/office/settings" && method === "PUT") {
      puts.push(body);
      return undefined;
    }
    return { items: [], nextBefore: null };
  });
  const view = render(<AuditPane />);
  await act(async () => {});
  const box = view.container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  // Not usable before the setting is known.
  expect(box.disabled).toBe(true);
  await act(async () => {
    release();
    await firstRead;
  });
  expect(box.disabled).toBe(false);
  expect(box.checked).toBe(false);
  // Another writer changed the settings since that read.
  version = "v2";
  await act(async () => {
    fireEvent.click(box);
  });
  await act(async () => {});
  expect(puts).toEqual([{ version: "v2", recordTerminals: true }]);
  expect(box.checked).toBe(true);
  view.unmount();
});
