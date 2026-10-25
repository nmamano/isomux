import { test, expect, spyOn } from "bun:test";
import { errors, type Frame } from "playwright-core";
import {
  PASSWORD_MASK,
  readBrowserFrames,
  resolveBrowserFrame,
} from "./browser-frames";
import {
  PASSWORD_LEAKS,
  PASSWORD_SNAPSHOT,
  PASSWORD_VALUES,
} from "./test-support/password-snapshot-fixture";

const PASSWORD_FIELDS = "input[type=password]";
const noPasswordFields = {
  count: async () => 0,
  nth: () => {
    throw new Error("no password field");
  },
};

function frame(text: string, children: Frame[] = [], detached = false): Frame {
  return {
    getByRole: () => ({}),
    childFrames: () => children,
    isDetached: () => detached,
    locator: (selector: string) =>
      selector === PASSWORD_FIELDS
        ? noPasswordFields
        : {
            innerText: async () => text,
            ariaSnapshot: async () => `- text: ${text}`,
            locator: () => ({
              and: () => ({
                and: () => ({ filter: () => ({ count: async () => 0 }) }),
              }),
            }),
          },
  } as unknown as Frame;
}

test("frame reads preserve root and label nested paths in depth-first order", async () => {
  const leaf = frame("Nested content");
  const root = frame("Shell", [
    frame("Same origin", [leaf]),
    frame("Cross origin"),
  ]);
  expect(resolveBrowserFrame(root, [0, 0])).toBe(leaf);
  expect(resolveBrowserFrame(root, [])).toBe(root);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000);
    expect(read.indexOf("Shell")).toBeLessThan(read.indexOf("Same origin"));
    expect(read.indexOf("Same origin")).toBeLessThan(
      read.indexOf("Nested content"),
    );
    expect(read.indexOf("Nested content")).toBeLessThan(
      read.indexOf("Cross origin"),
    );
    for (const path of [[0], [0, 0], [1]])
      expect(read).toContain(`framePath=${JSON.stringify(path)}`);
  }
});

test("missing or detached paths fail before an element action", () => {
  const root = frame("Shell", [frame("Detached", [], true)]);
  expect(() => resolveBrowserFrame(root, [1])).toThrow();
  expect(() => resolveBrowserFrame(root, [0])).toThrow();
});

test("unavailable frames keep readable siblings and hide exception content", async () => {
  const bad = frame("unused");
  bad.locator = () => {
    throw new Error("private exception content");
  };
  const root = frame("Shell", [
    frame("Detached", [], true),
    bad,
    frame("Readable sibling"),
  ]);
  const read = await readBrowserFrames(root, "text", 20_000, 1000);
  expect(read).toContain("Readable sibling");
  expect(read).toContain("framePath=[2]");
  expect(read).not.toContain("private exception content");
  expect(read).not.toContain("Detached");
});

// A frame read fails for one of three reasons the agent can act on: it ran
// out of time (read the frame alone), the frame closed or navigated away
// (read again), or something else. The marker names the class only.
test("an unavailable frame names its reason class without exception content", async () => {
  const failing = (
    error: () => Error,
    detachedAfter = false,
    detachedBefore = false,
  ) => {
    let failed = false;
    const fail = async () => {
      failed = true;
      throw error();
    };
    const child = frame("unused");
    child.isDetached = () => detachedBefore || (detachedAfter && failed);
    child.locator = (selector: string) =>
      (selector === PASSWORD_FIELDS
        ? noPasswordFields
        : { innerText: fail, ariaSnapshot: fail }) as unknown as ReturnType<
        Frame["locator"]
      >;
    return child;
  };
  const timeout = () => new errors.TimeoutError("private timeout content");
  const children = {
    timeout: failing(timeout),
    secondTimeout: failing(timeout),
    closedDuringRead: failing(() => new Error("private closed content"), true),
    closedBeforeRead: failing(() => new Error("unused"), false, true),
    navigated: failing(
      () =>
        new Error(
          "Execution context was destroyed, most likely because of a navigation",
        ),
    ),
    other: failing(() => new Error("private other content")),
  };
  const names = Object.keys(children);
  const root = frame("Shell", Object.values(children));
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000);
    expect(read).not.toContain("private");
    const marker = Object.fromEntries(
      names.map((name, index) => [
        name,
        read
          .split(`--- Frame framePath=[${index}] ---\n`)[1]
          .split("\n\n--- Frame")[0],
      ]),
    );
    expect(marker.secondTimeout).toBe(marker.timeout);
    expect(marker.closedBeforeRead).toBe(marker.closedDuringRead);
    expect(marker.navigated).toBe(marker.closedDuringRead);
    expect(
      new Set([marker.timeout, marker.closedDuringRead, marker.other]).size,
    ).toBe(3);
    // A slow frame gets the whole budget when read alone.
    expect(marker.timeout).toContain("framePath");
    for (const value of Object.values(marker))
      expect(value.trim()).not.toBe("");
  }
});

test("one output budget covers root, frame boundaries and child content", async () => {
  const root = frame("root", [
    frame("x".repeat(500)),
    frame("omitted sibling"),
  ]);
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 100, 1000);
    expect(read.length).toBe(100);
    expect(read).toContain("root");
    expect(read).toContain("framePath=[0]");
    expect(read).not.toContain("omitted sibling");
  }
  expect(
    (
      await readBrowserFrames(
        frame(
          "Shell",
          Array.from({ length: 100 }, () => frame("child")),
        ),
        "text",
        20_000,
        1000,
      )
    ).match(/framePath=/g),
  ).toHaveLength(63);
});

test("scoped reads select one frame and one locator without child traversal", async () => {
  const child = frame("Child", [frame("Outside scope")]);
  const root = frame("Root", [child]);
  const selectors: string[] = [];
  const original = child.locator.bind(child);
  child.locator = (selector: string) => {
    selectors.push(selector);
    return original(selector);
  };
  for (const action of ["text", "snapshot"] as const) {
    const read = await readBrowserFrames(root, action, 20_000, 1000, {
      framePath: [0],
      selector: "#entry",
    });
    expect(read).toContain("Child");
    expect(read).not.toContain("Root");
    expect(read).not.toContain("Outside scope");
    expect(read).not.toContain("framePath=");
  }
  expect(selectors.filter((selector) => selector === "#entry")).toHaveLength(2);
  expect(selectors).not.toContain("body");
  expect(
    await readBrowserFrames(root, "text", 20_000, 1000, {
      framePath: [9],
    }).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
});

function editableFrame(
  snapshot: (timeout: number) => string,
  count: () => number,
  read: (index: number, timeout: number) => string,
): Frame {
  const boxes = {
    count: async () => count(),
    nth: (index: number) => ({
      innerText: async ({ timeout }: { timeout: number }) =>
        read(index, timeout),
    }),
  };
  return {
    childFrames: () => [],
    isDetached: () => false,
    getByRole: () => ({}),
    locator: (selector: string) =>
      selector === PASSWORD_FIELDS
        ? noPasswordFields
        : {
            ariaSnapshot: async ({ timeout }: { timeout: number }) =>
              snapshot(timeout),
            locator: () => ({
              and: () => ({ and: () => ({ filter: () => boxes }) }),
            }),
          },
  } as unknown as Frame;
}

test("editable scan shares the snapshot deadline and stops after empty candidates", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const calls: { at: number; timeout: number }[] = [];
  try {
    const root = editableFrame(
      (timeout) => {
        expect(timeout).toBe(10);
        now += 4;
        return "- textbox";
      },
      () => 1000,
      (_index, timeout) => {
        calls.push({ at: now, timeout });
        now += 2;
        return "";
      },
    );
    const read = await readBrowserFrames(root, "snapshot", 20_000, 10);
    expect(read).toContain("textbox");
    expect(calls).toEqual([
      { at: 1004, timeout: 6 },
      { at: 1006, timeout: 4 },
      { at: 1008, timeout: 2 },
    ]);
    expect(now).toBe(1010);
  } finally {
    clock.mockRestore();
  }
});

test("expired snapshot or candidate count does not start editable reads", async () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const snapshotMs of [6, 10]) {
      now = 1000;
      let counts = 0;
      let reads = 0;
      const root = editableFrame(
        () => {
          now += snapshotMs;
          return "- textbox";
        },
        () => {
          counts++;
          now += 4;
          return 1000;
        },
        () => {
          reads++;
          return "";
        },
      );
      const read = await readBrowserFrames(root, "snapshot", 20_000, 10);
      expect(read).toContain("textbox");
      expect(counts).toBe(snapshotMs === 10 ? 0 : 1);
      expect(reads).toBe(0);
    }
  } finally {
    clock.mockRestore();
  }
});

test("deadline keeps collected editable text and propagates locator timeouts", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    let reads = 0;
    const root = editableFrame(
      () => {
        now += 2;
        return "- textbox";
      },
      () => 1000,
      (index) => {
        reads++;
        now += 4;
        return index === 0 ? "Collected draft" : "";
      },
    );
    expect(await readBrowserFrames(root, "snapshot", 20_000, 10)).toContain(
      "Collected draft",
    );
    expect(reads).toBe(2);
    const timeout = new Error("private locator diagnostic");
    timeout.name = "TimeoutError";
    const stalled = editableFrame(
      () => "- textbox",
      () => 1,
      () => {
        throw timeout;
      },
    );
    expect(
      await readBrowserFrames(stalled, "snapshot", 20_000, 10).then(
        () => false,
        (error) => error === timeout,
      ),
    ).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

type PasswordRead = {
  phase: "before" | "after";
  index: number;
  timeout: number;
};

// A frame with password fields. values() is read at each count and each read,
// so a snapshot can change the fields while it runs.
function passwordFrame(options: {
  snapshot: string | (() => string);
  values: () => string[];
  read?: (read: PasswordRead) => void;
  editable?: string[];
  children?: Frame[];
}): Frame {
  let phase: PasswordRead["phase"] = "before";
  const editable = options.editable ?? [];
  const boxes = {
    count: async () => editable.length,
    nth: (index: number) => ({ innerText: async () => editable[index] }),
  };
  return {
    childFrames: () => options.children ?? [],
    isDetached: () => false,
    getByRole: () => ({}),
    locator: (selector: string) =>
      selector === PASSWORD_FIELDS
        ? {
            count: async () => options.values().length,
            nth: (index: number) => ({
              inputValue: async ({ timeout }: { timeout: number }) => {
                options.read?.({ phase, index, timeout });
                return options.values()[index];
              },
            }),
          }
        : {
            innerText: async () => "",
            ariaSnapshot: async () => {
              const snapshot =
                typeof options.snapshot === "string"
                  ? options.snapshot
                  : options.snapshot();
              phase = "after";
              return snapshot;
            },
            locator: () => ({
              and: () => ({ and: () => ({ filter: () => boxes }) }),
            }),
          },
  } as unknown as Frame;
}

// PASSWORD_SNAPSHOT line by line after the mask. A value that Playwright
// quotes may keep its quotes around the mask. "xyz" is too short to be masked
// inside another node's name; masking it there too is also correct.
function expectMasked(read: string) {
  const mask = PASSWORD_MASK;
  const quotedValue = (key: string) => [`${key} ${mask}`, `${key} "${mask}"`];
  const expected: string[][] = [
    ["- text: Password"],
    [`- textbox "Password": ${mask}`],
    quotedValue('- textbox "Quoted":'),
    [`- textbox "Spaces": ${mask}`],
    ['- textbox "Hint":'],
    ["  - /placeholder: Enter it"],
    [`  - text: ${mask}`],
    [`- textbox: ${mask}`],
    [`- button "${mask}": Go`],
    quotedValue("- textbox:"),
    [`- 'button "${mask}"': Go`],
    [`- textbox: ${mask}`],
    [`- button "${mask}": Go`],
    [`- textbox "PIN": ${mask}`],
    ["- paragraph: Step 3 of 4"],
    ['- link "Page 3":'],
    ['  - /url: "#"'],
    [`- textbox: ${mask}`],
    [`- button "${mask}": Go`],
    [`- textbox "Upper": ${mask}`],
    [`- textbox: ${mask}`],
    ['- button "xyz": Go', `- button "${mask}": Go`],
  ];
  const lines = read.split("\n");
  expect(lines).toHaveLength(expected.length);
  lines.forEach((line, index) => expect(line).toBeOneOf(expected[index]));
  for (const leak of PASSWORD_LEAKS) expect(read).not.toContain(leak);
}

test("snapshot masks every rendered form of a password value in root, child and scoped reads", async () => {
  const fields = () => PASSWORD_VALUES;
  expectMasked(
    await readBrowserFrames(
      passwordFrame({ snapshot: PASSWORD_SNAPSHOT, values: fields }),
      "snapshot",
      20_000,
      1000,
    ),
  );
  const root = passwordFrame({
    snapshot: "- text: Shell",
    values: () => [],
    children: [passwordFrame({ snapshot: PASSWORD_SNAPSHOT, values: fields })],
  });
  const [shell, child] = (
    await readBrowserFrames(root, "snapshot", 20_000, 1000)
  ).split("\n\n--- Frame framePath=[0] ---\n");
  expect(shell).toBe("- text: Shell");
  expectMasked(child);
  expectMasked(
    await readBrowserFrames(root, "snapshot", 20_000, 1000, {
      framePath: [0],
      selector: "#login",
    }),
  );
});

test("a password value that appears or clears while the snapshot runs is still masked", async () => {
  for (const [before, after] of [
    ["", "autofilled-secret"],
    ["typed-secret", ""],
  ]) {
    let current = before;
    const frame = passwordFrame({
      snapshot: () => {
        current = after;
        return `- textbox "Password": ${before || after}`;
      },
      values: () => [current],
    });
    expect(await readBrowserFrames(frame, "snapshot", 20_000, 1000)).toBe(
      `- textbox "Password": ${PASSWORD_MASK}`,
    );
  }
});

test("each password pass gets a 1000 ms floor shared by its reads, after the snapshot used the budget", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const reads: PasswordRead[] = [];
    const frame = passwordFrame({
      snapshot: () => {
        now += 10;
        return '- textbox "A": first-secret\n- textbox "B": second-secret';
      },
      values: () => ["first-secret", "second-secret"],
      read: (read) => {
        reads.push(read);
        if (read.phase === "after") now += 300;
      },
    });
    expect(await readBrowserFrames(frame, "snapshot", 20_000, 10)).toBe(
      `- textbox "A": ${PASSWORD_MASK}\n- textbox "B": ${PASSWORD_MASK}`,
    );
    expect(reads).toEqual([
      { phase: "before", index: 0, timeout: 1000 },
      { phase: "before", index: 1, timeout: 1000 },
      { phase: "after", index: 0, timeout: 1000 },
      { phase: "after", index: 1, timeout: 700 },
    ]);
  } finally {
    clock.mockRestore();
  }
});

test("a failed password read fails the root read and hides a child frame's snapshot", async () => {
  for (const failing of ["before", "after"] as const) {
    const secretFrame = () =>
      passwordFrame({
        snapshot: '- textbox "Password": child-secret',
        values: () => ["child-secret"],
        read: (read) => {
          if (read.phase === failing)
            throw new Error("password read failed: child-secret");
        },
      });
    expect(
      await readBrowserFrames(secretFrame(), "snapshot", 20_000, 1000).then(
        (read) => read,
        (error: Error) => error.message,
      ),
    ).toBe("password read failed: child-secret");
    const read = await readBrowserFrames(
      passwordFrame({
        snapshot: "- text: Shell",
        values: () => [],
        children: [
          secretFrame(),
          passwordFrame({ snapshot: "- text: Sibling", values: () => [] }),
        ],
      }),
      "snapshot",
      20_000,
      1000,
    );
    expect(read).toContain("- text: Shell");
    expect(read).toContain("framePath=[0]");
    expect(read).toContain("framePath=[1]");
    expect(read).toContain("- text: Sibling");
    expect(read).not.toContain("child-secret");
  }
});

test("the mask covers the editable text section and runs before the output limit cuts", async () => {
  const secret = "longsecretvalue-0123456789-abcdefghijklm";
  const line = `- textbox "P": ${secret}`;
  // Cut one character short: a mask after the cut would see only a prefix.
  expect(
    await readBrowserFrames(
      passwordFrame({ snapshot: line, values: () => [secret] }),
      "snapshot",
      line.length - 1,
      1000,
    ),
  ).toBe(`- textbox "P": ${PASSWORD_MASK}`);
  const read = await readBrowserFrames(
    passwordFrame({
      snapshot: '- textbox "Notes"',
      values: () => [secret],
      editable: [`draft with ${secret}`],
    }),
    "snapshot",
    20_000,
    1000,
  );
  expect(read).toContain(`"draft with ${PASSWORD_MASK}"`);
  expect(read).not.toContain("longsecret");
});
