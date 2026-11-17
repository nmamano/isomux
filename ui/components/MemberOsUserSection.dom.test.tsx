// Settings > Members > a member > OS user (task b94dfd25 4c-i). The
// properties:
// - where the root command cannot run, only the reason shows (one line per
//   reason, no command); nothing renders when the read fails or the answer
//   has no support field (an older server);
// - there, a disabled field shows the OS user the member's agents run as:
//   their own, else the office's while off; none when broken or unknown
//   (task 83ebaa3c); the off line names the office's OS user when known;
// - not ready after a move that a stop cut says so, with its own hint over
//   the enable command; a command with the container placeholder adds the
//   hint to name the container;
// - the section shows the state, and the command for the state: enable
//   while off, disable otherwise; Copy copies that command;
// - one status row (member-os-user-status, task 77b253f0) while the state
//   can change: running (an attempt runs, or the files move) before waiting
//   (after a Copy) before failed (the last attempt failed or stopped). A
//   transition shows the row alone: no state line, no command, Copy, Run,
//   command hint or picker (a wait keeps the commands to copy again). A
//   failure shows under the state line: a short reason, the full message
//   folded in a closed <details>;
// - an adopted user's hint sits in each disable command's block;
// - the page reads again every OS_USER_POLL_MS only while the state can
//   change (an attempt running, or after a Copy until the state changes), and
//   stops on a final state, on unmount and at OS_USER_POLL_CAP_MS;
// - Run (4c-iii): with a password field where sudo asks for one, a button
//   only where it does not, nothing without run; each command's own verb,
//   the field cleared and the state read again after a start; no Run while
//   a run goes on or with an empty field; a wrong password says how many
//   tries are left, and a lock says so.
import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { MemberOsUserSection, OS_USER_POLL_MS, OS_USER_POLL_CAP_MS } =
  await import("./MemberOsUserSection.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
import type { MemberOsUserWire } from "../../shared/contract-shapes.ts";

const t = translatorFor("en").t;
const ROUTE = "/api/users/Mia/os-user";
const COMMANDS = {
  enable: "sudo /usr/local/sbin/isomux-member-user enable 0a1b2c3d",
  disable: "sudo /usr/local/sbin/isomux-member-user disable 0a1b2c3d",
};

// What the next reads answer: the head of the queue, the last one repeats.
let answers: (MemberOsUserWire | "fail")[] = [];
let reads = 0;
// The owner's Run (4c-iii): each POST, and what the next one answers.
const RUN_ROUTE = "/api/users/Mia/os-user/run";
let posts: unknown[] = [];
let runAnswer: (() => unknown) | null = null;
setApiShim(async (method, path, body) => {
  if (method === "POST" && path === RUN_ROUTE) {
    posts.push(body);
    if (runAnswer) return runAnswer();
    return { action: (body as { action: string }).action };
  }
  if (method === "GET" && path === ROUTE) {
    reads++;
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === "fail" || next === undefined)
      throw new ApiError(500, "boom", "internal");
    return next;
  }
  throw new Error(`unexpected ${method} ${path}`);
});

const savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let copied: string[] = [];
beforeEach(() => {
  answers = [];
  reads = 0;
  posts = [];
  runAnswer = null;
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});
afterEach(() => {
  jest.useRealTimers();
  if (savedClipboard)
    Object.defineProperty(navigator, "clipboard", savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
});

function view(over: Partial<MemberOsUserWire> = {}): MemberOsUserWire {
  return {
    state: "off",
    commands: COMMANDS,
    run: null,
    support: { ok: true },
    ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

async function mount() {
  const rendered = render(
    onLanguage(
      null,
      createElement(MemberOsUserSection, {
        username: "Mia",
        headingStyle: {},
        hintStyle: {},
      }),
    ),
  );
  await settle();
  const q = (id: string) =>
    rendered.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { rendered, q };
}

const commandLines = (m: Awaited<ReturnType<typeof mount>>) =>
  [
    ...m.rendered.container.querySelectorAll<HTMLElement>(
      '[data-testid="member-os-user-command"]',
    ),
  ].map((el) => el.textContent);
const statusKinds = (m: Awaited<ReturnType<typeof mount>>) =>
  [
    ...m.rendered.container.querySelectorAll<HTMLElement>(
      '[data-testid="member-os-user-status"]',
    ),
  ].map((el) => el.dataset.kind ?? "");

// Advance the fake clock by `ms` and let the reads it starts answer.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

it("shows only the reason where the command cannot run, and nothing when the read fails or has no support", async () => {
  const lines = new Set<string>();
  const reasons = [
    "not_linux",
    "kubernetes",
    "render",
    "no_system_install",
    "no_command",
  ] as const;
  for (const reason of reasons) {
    answers = [view({ support: { ok: false, reason }, commands: null })];
    const closed = await mount();
    const line = closed.q("member-os-user-unsupported");
    expect({ reason, shown: line?.dataset.reason }).toEqual({
      reason,
      shown: reason,
    });
    lines.add(line?.textContent ?? "");
    expect(closed.q("member-os-user-command")).toBeNull();
    expect(closed.q("member-os-user-state")).toBeNull();
    closed.rendered.unmount();
  }
  // One line per reason.
  expect(lines.size).toBe(reasons.length);
  expect(lines.has("")).toBe(false);

  answers = ["fail"];
  const failed = await mount();
  expect(failed.q("member-os-user")).toBeNull();
  failed.rendered.unmount();
  // An older server answers without support.
  const { support: _support, ...old } = view();
  answers = [old as MemberOsUserWire];
  const older = await mount();
  expect(older.q("member-os-user")).toBeNull();
});

it("shows the OS user the member's agents run as in a disabled field where it cannot change", async () => {
  const unsupported = {
    ok: false as const,
    reason: "no_system_install" as const,
  };
  const cases: {
    over: Partial<MemberOsUserWire>;
    name: string | null;
  }[] = [
    { over: { state: "off", officeOsUser: "svc-office" }, name: "svc-office" },
    {
      over: {
        state: "on",
        osUser: { name: "isomux-mia", uid: 2001 },
        officeOsUser: "svc-office",
      },
      name: "isomux-mia",
    },
    {
      over: {
        state: "not_ready",
        osUser: { name: "isomux-mia", uid: 2001 },
      },
      name: "isomux-mia",
    },
    // A damaged record says nothing about which user runs them.
    {
      over: { state: "broken", reason: "bad json", officeOsUser: "svc-office" },
      name: null,
    },
    // An older server, or a uid with no passwd entry.
    { over: { state: "off" }, name: null },
  ];
  for (const { over, name } of cases) {
    answers = [view({ ...over, support: unsupported, commands: null })];
    const m = await mount();
    // The enabling condition: the unsupported branch rendered.
    expect(m.q("member-os-user-unsupported")?.dataset.reason).toBe(
      "no_system_install",
    );
    const field = m.q("member-os-user-name") as HTMLInputElement | null;
    expect({
      state: over.state,
      tag: field?.tagName ?? null,
      value: field?.value ?? null,
      disabled: field?.disabled ?? null,
      label: field ? !!field.getAttribute("aria-label") : null,
    }).toEqual({
      state: over.state,
      tag: name === null ? null : "INPUT",
      value: name,
      disabled: name === null ? null : true,
      label: name === null ? null : true,
    });
    m.rendered.unmount();
  }
});

it("names the office's OS user in the off line when the server sends it", async () => {
  answers = [view({ officeOsUser: "svc-office" })];
  const named = await mount();
  expect(named.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(named.q("member-os-user-state")?.textContent).toContain("svc-office");
  named.rendered.unmount();
  // Without it, the off line still shows, with no placeholder left.
  answers = [view()];
  const plain = await mount();
  const line = plain.q("member-os-user-state")?.textContent ?? "";
  expect(plain.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(line).toBe(t("settings.osUser.off"));
});

it("shows the enable command while off, and the disable command with the failed attempt's message otherwise", async () => {
  answers = [view()];
  const off = await mount();
  expect(off.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(off.q("member-os-user-command")?.textContent).toBe(COMMANDS.enable);
  expect(off.q("member-os-user-status")).toBeNull();
  off.rendered.unmount();

  answers = [
    view({
      state: "on",
      osUser: { name: "isomux-mia", uid: 2001 },
      attempt: {
        action: "disable",
        status: "failed",
        at: 1,
        message: "the member's runner is not connected",
      },
    }),
  ];
  const on = await mount();
  expect(on.q("member-os-user-state")?.dataset.state).toBe("on");
  expect(on.q("member-os-user-state")?.textContent).toContain("isomux-mia");
  expect(on.q("member-os-user-command")?.textContent).toBe(COMMANDS.disable);
  expect(on.q("member-os-user-status")?.dataset.kind).toBe("failed");
  expect(on.q("member-os-user-status")?.textContent).toContain(
    "the member's runner is not connected",
  );
  on.rendered.unmount();

  // No command where the root command cannot run: no command block.
  answers = [view({ commands: null })];
  const none = await mount();
  expect(none.q("member-os-user")).not.toBeNull();
  expect(none.q("member-os-user-command")).toBeNull();
});

// Not ready can be an enable that the office's restart cut: a rerun of the
// enable finishes it, so the page offers it first, then the way out.
it("shows the enable command again, then the disable command, while not ready", async () => {
  answers = [
    view({
      state: "not_ready",
      osUser: { name: "isomux-mia", uid: 2001 },
    }),
  ];
  const notReady = await mount();
  expect(notReady.q("member-os-user-state")?.dataset.state).toBe("not_ready");
  const lines = [
    ...notReady.rendered.container.querySelectorAll<HTMLElement>(
      '[data-testid="member-os-user-command"]',
    ),
  ].map((el) => el.textContent);
  expect(lines).toEqual([COMMANDS.enable, COMMANDS.disable]);
});

it("says when a move did not finish, with its own hint over the enable command", async () => {
  const osUser = { name: "isomux-mia", uid: 2001 };
  const texts = async (over: Partial<MemberOsUserWire>) => {
    answers = [view({ state: "not_ready", osUser, ...over })];
    const m = await mount();
    const commands = [
      ...m.rendered.container.querySelectorAll<HTMLElement>(
        '[data-testid="member-os-user-command"]',
      ),
    ];
    const out = {
      state: m.q("member-os-user-state")?.textContent ?? "",
      // The hint line just above the first command block.
      hint:
        commands[0]?.closest("div[style]")?.previousElementSibling
          ?.textContent ?? "",
      lines: commands.map((el) => el.textContent),
    };
    m.rendered.unmount();
    return out;
  };
  const cut = await texts({ unfinished: true });
  const plain = await texts({});
  expect(cut.lines).toEqual([COMMANDS.enable, COMMANDS.disable]);
  expect(cut.state).not.toBe(plain.state);
  expect(cut.hint).not.toBe("");
  expect(cut.hint).not.toBe(plain.hint);
});

it("asks for the container's name only when the command holds the placeholder", async () => {
  answers = [view({ commandHint: "container_name" })];
  const hinted = await mount();
  expect(hinted.q("member-os-user-command-hint")).not.toBeNull();
  hinted.rendered.unmount();
  answers = [view()];
  const plain = await mount();
  expect(plain.q("member-os-user-command-hint")).toBeNull();
  plain.rendered.unmount();
  // No command, no hint.
  answers = [view({ commandHint: "container_name", commands: null })];
  const none = await mount();
  expect(none.q("member-os-user-command-hint")).toBeNull();
});

it("reads again while an attempt runs, and stops when it ends and on unmount", async () => {
  jest.useFakeTimers();
  const running = view({
    attempt: { action: "enable", status: "running", at: 1 },
  });
  const done = view({ state: "on", osUser: { name: "isomux-mia", uid: 2001 } });
  answers = [running, running, done];
  const m = await mount();
  expect(reads).toBe(1);
  expect(m.q("member-os-user-status")?.dataset.kind).toBe("running");
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(2);
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(3);
  expect(m.q("member-os-user-state")?.dataset.state).toBe("on");
  // A final state: no more reads.
  await advance(OS_USER_POLL_MS * 5);
  expect(reads).toBe(3);
  m.rendered.unmount();

  // Unmounted while running: no read after.
  answers = [running];
  reads = 0;
  const again = await mount();
  expect(reads).toBe(1);
  again.rendered.unmount();
  await advance(OS_USER_POLL_MS * 3);
  expect(reads).toBe(1);
});

it("after a Copy, waits and reads until the state changes", async () => {
  jest.useFakeTimers();
  const off = view();
  const started = view({
    attempt: { action: "enable", status: "running", at: 5 },
  });
  // The run is cancelled (a restart): the page reads off again, as before
  // the Copy. The wait is over all the same.
  answers = [off, off, started, off];
  const m = await mount();
  // Nothing can change before a Copy: no reads.
  await advance(OS_USER_POLL_MS * 3);
  expect(reads).toBe(1);
  expect(m.q("member-os-user-status")).toBeNull();
  const copy = m.rendered.container.querySelector<HTMLButtonElement>(
    '[data-testid="member-os-user"] button',
  )!;
  await act(async () => {
    fireEvent.click(copy);
  });
  await settle();
  expect(copied).toEqual([COMMANDS.enable]);
  // Waiting is the status: the state line goes, the command stays to copy
  // again.
  expect(statusKinds(m)).toEqual(["waiting"]);
  expect(m.q("member-os-user-state")).toBeNull();
  expect(commandLines(m)).toEqual([COMMANDS.enable]);
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(2);
  expect(statusKinds(m)).toEqual(["waiting"]);
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(3);
  // The command began: running replaces waiting.
  expect(statusKinds(m)).toEqual(["running"]);
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(4);
  expect(m.q("member-os-user-state")?.dataset.state).toBe("off");
  // Not waiting again, and no more reads.
  expect(statusKinds(m)).toEqual([]);
  await advance(OS_USER_POLL_MS * 5);
  expect(reads).toBe(4);
});

it("stops reading at OS_USER_POLL_CAP_MS", async () => {
  jest.useFakeTimers();
  answers = [view({ attempt: { action: "enable", status: "running", at: 1 } })];
  await mount();
  await advance(OS_USER_POLL_CAP_MS + OS_USER_POLL_MS);
  const atCap = reads;
  expect(atCap).toBeGreaterThan(1);
  await advance(OS_USER_POLL_MS * 10);
  expect(reads).toBe(atCap);
});

// Task b94dfd25 4c-iii: Run on the page.
const runButtons = (m: Awaited<ReturnType<typeof mount>>) => [
  ...m.rendered.container.querySelectorAll<HTMLButtonElement>(
    '[data-testid="member-os-user-run"]',
  ),
];
const passwordFields = (m: Awaited<ReturnType<typeof mount>>) => [
  ...m.rendered.container.querySelectorAll<HTMLInputElement>(
    '[data-testid="member-os-user-password"]',
  ),
];
const typeInto = async (field: HTMLInputElement, text: string) => {
  await act(async () => {
    fireEvent.change(field, { target: { value: text } });
  });
};
const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
};

it("shows a password field and Run beside each command where sudo asks for a password, and runs that command's verb", async () => {
  answers = [
    view({
      state: "not_ready",
      osUser: { name: "isomux-mia", uid: 2001 },
      run: "password",
    }),
  ];
  const m = await mount();
  const fields = passwordFields(m);
  const buttons = runButtons(m);
  expect([fields.length, buttons.length]).toEqual([2, 2]);
  for (const field of fields) {
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
  }
  // Copy stays beside Run.
  expect(
    m.rendered.container.querySelectorAll(
      '[data-testid="member-os-user-command"]',
    ).length,
  ).toBe(2);
  // An empty field: no run.
  expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
  await typeInto(fields[1], "s3cret");
  expect(runButtons(m)[1].disabled).toBe(false);
  const before = reads;
  await click(runButtons(m)[1]);
  expect(posts).toEqual([{ action: "disable", password: "s3cret" }]);
  // Cleared, and the state is read again.
  expect(passwordFields(m)[1].value).toBe("");
  expect(reads).toBeGreaterThan(before);
  await typeInto(passwordFields(m)[0], "other");
  await click(runButtons(m)[0]);
  expect(posts.at(-1)).toEqual({ action: "enable", password: "other" });
});

it("shows Run alone where sudo asks for no password, and nothing where the page cannot run", async () => {
  answers = [view({ run: "no_password" })];
  const free = await mount();
  expect(passwordFields(free)).toHaveLength(0);
  expect(runButtons(free)).toHaveLength(1);
  expect(runButtons(free)[0].disabled).toBe(false);
  await click(runButtons(free)[0]);
  expect(posts).toEqual([{ action: "enable" }]);
  free.rendered.unmount();
  answers = [view({ run: null })];
  const none = await mount();
  expect([runButtons(none).length, passwordFields(none).length]).toEqual([
    0, 0,
  ]);
  expect(none.q("member-os-user-command")?.textContent).toBe(COMMANDS.enable);
});

it("says how many tries are left after a wrong password, and that the member is locked after the last", async () => {
  answers = [view({ run: "password" })];
  const m = await mount();
  expect(passwordFields(m)).toHaveLength(1);
  runAnswer = () => {
    throw new ApiError(422, "not_started", "not started", {
      reason: "sudo: 1 incorrect password attempt",
      attemptsLeft: 2,
    });
  };
  await typeInto(passwordFields(m)[0], "wrong");
  await click(runButtons(m)[0]);
  const wrong = m.q("member-os-user-run-error")?.textContent ?? "";
  expect(wrong).toContain("sudo: 1 incorrect password attempt");
  expect(wrong).toContain("2");
  runAnswer = () => {
    throw new ApiError(429, "locked_out", "locked", { retryAfterS: 900 });
  };
  await typeInto(passwordFields(m)[0], "wrong");
  await click(runButtons(m)[0]);
  const locked = m.q("member-os-user-run-error")?.textContent ?? "";
  expect(locked).not.toBe("");
  expect(locked).not.toBe(wrong);
  // The wait in minutes, from the answer's retryAfterS.
  expect(locked).toContain("15");
});

// Slice 5c-3 (task 78733adf): a member who came with an office move. The
// page says why she is not ready, with its own hints; the disable command is
// the one the server sends (it deletes her moved home); Run sits beside the enable
// command only, since a plain disable of her is refused.
it("a member who came with an office move: her own state and hints, the enable and the server's disable command, and Run beside enable only", async () => {
  const osUser = { name: "isomux-mia", uid: 2001 };
  const DISABLE_MOVED = `${COMMANDS.disable} --delete-moved-home`;
  const texts = async (over: Partial<MemberOsUserWire>) => {
    answers = [
      view({ state: "not_ready", osUser, run: "no_password", ...over }),
    ];
    const m = await mount();
    const commands = [
      ...m.rendered.container.querySelectorAll<HTMLElement>(
        '[data-testid="member-os-user-command"]',
      ),
    ];
    const out = {
      stateEl: m.q("member-os-user-state"),
      state: m.q("member-os-user-state")?.textContent ?? "",
      hints: commands.map(
        (el) =>
          el.closest("div[style]")?.previousElementSibling?.textContent ?? "",
      ),
      lines: commands.map((el) => el.textContent),
      // The command each Run sits beside: the command block that holds its
      // form.
      runs: runButtons(m).map(
        (b) =>
          b
            .closest("form")
            ?.parentElement?.querySelector(
              '[data-testid="member-os-user-command"]',
            )?.textContent ?? null,
      ),
      m,
    };
    return out;
  };
  const moved = await texts({
    movedIn: true,
    commands: { enable: COMMANDS.enable, disable: DISABLE_MOVED },
  });
  expect({
    state: moved.stateEl?.dataset.state,
    movedIn: moved.stateEl?.dataset.movedIn,
    lines: moved.lines,
    runs: moved.runs,
  }).toEqual({
    state: "not_ready",
    movedIn: "true",
    lines: [COMMANDS.enable, DISABLE_MOVED],
    runs: [COMMANDS.enable],
  });
  await click(runButtons(moved.m)[0]);
  expect(posts).toEqual([{ action: "enable" }]);
  moved.m.rendered.unmount();
  // The enabling case: a plain not-ready member, Run beside both.
  const plain = await texts({});
  expect(plain.runs).toEqual([COMMANDS.enable, COMMANDS.disable]);
  expect(plain.stateEl?.dataset.movedIn).toBeUndefined();
  // Her own lines, not the plain ones and not the cut-move ones.
  plain.m.rendered.unmount();
  const cut = await texts({ unfinished: true });
  expect(moved.state).not.toBe(plain.state);
  expect(moved.state).not.toBe(cut.state);
  expect(moved.hints[0]).not.toBe(plain.hints[0]);
  expect(moved.hints[0]).not.toBe(cut.hints[0]);
  expect(moved.hints[1]).not.toBe(plain.hints[1]);
  for (const h of moved.hints) expect(h).not.toBe("");
});

// Task e15a82e7: the owner picks the member's OS user. While off, a server
// that sends newUserName gets a picker (member-os-user-pick): the office's
// user (the current one, picked at first, no command), each candidate
// ("existing:<name>"), a new user ("new", a name field that starts with
// newUserName) and, where candidates come (the installer's install), another
// existing user by name ("other"). The command line and Run carry the pick;
// a name off the pattern gives no command and no Run. On: an adopted user
// says so, and a root-capable one shows the warning.
const pickOf = (m: Awaited<ReturnType<typeof mount>>) =>
  m.q("member-os-user-pick") as HTMLSelectElement | null;
const optionValues = (m: Awaited<ReturnType<typeof mount>>) =>
  [...(pickOf(m)?.options ?? [])].map((o) => o.value);
const pick = async (m: Awaited<ReturnType<typeof mount>>, value: string) => {
  await act(async () => {
    fireEvent.change(pickOf(m)!, { target: { value } });
  });
  await settle();
};
const picker = (over: Partial<MemberOsUserWire> = {}) =>
  view({
    officeOsUser: "svc-office",
    newUserName: "isomux-mia",
    candidates: [
      { name: "bob", uid: 1001 },
      { name: "carol", uid: 1500 },
    ],
    run: "no_password",
    ...over,
  });

it("picks the office's user first, with no command, then lists each candidate, a new user and another existing user", async () => {
  answers = [picker()];
  const m = await mount();
  expect(pickOf(m)?.value).toBe("office");
  expect(optionValues(m)).toEqual([
    "office",
    "existing:bob",
    "existing:carol",
    "new",
    "other",
  ]);
  // The office's user is named in its option.
  expect(pickOf(m)?.options[0].textContent).toContain("svc-office");
  expect(commandLines(m)).toEqual([]);
  expect(runButtons(m).length).toBe(0);
});

it("a candidate gives the enable command with --existing-user, and Run sends it", async () => {
  answers = [picker()];
  const m = await mount();
  await pick(m, "existing:carol");
  expect(commandLines(m)).toEqual([`${COMMANDS.enable} --existing-user carol`]);
  await click(runButtons(m)[0]);
  expect(posts).toEqual([
    { action: "enable", osUser: "carol", existing: true },
  ]);
});

it("a new user starts with the default name, follows the field, and gives no command or Run for a name off the pattern", async () => {
  answers = [picker()];
  const m = await mount();
  await pick(m, "new");
  const field = m.q("member-os-user-new-name") as HTMLInputElement;
  expect(field.value).toBe("isomux-mia");
  expect(commandLines(m)).toEqual([`${COMMANDS.enable} --user isomux-mia`]);
  await typeInto(field, "isomux-mia2");
  expect(commandLines(m)).toEqual([`${COMMANDS.enable} --user isomux-mia2`]);
  await click(runButtons(m)[0]);
  expect(posts).toHaveLength(1);
  const sentBody = posts[0] as Record<string, unknown>;
  expect([
    sentBody.action,
    sentBody.osUser,
    sentBody.existing === true,
  ]).toEqual(["enable", "isomux-mia2", false]);
  for (const bad of ["Mia Lopez", "mia;id", "-x", ""]) {
    await typeInto(m.q("member-os-user-new-name") as HTMLInputElement, bad);
    expect({ bad, lines: commandLines(m) }).toEqual({ bad, lines: [] });
    expect({
      bad,
      runs: runButtons(m).filter((b) => !b.disabled).length,
    }).toEqual({ bad, runs: 0 });
  }
});

it("another existing user is typed by name: --existing-user with that name, nothing while the field is empty", async () => {
  answers = [picker({ candidates: [] })];
  const m = await mount();
  // An empty list still offers another existing user (an LDAP box).
  expect(optionValues(m)).toEqual(["office", "new", "other"]);
  await pick(m, "other");
  const field = m.q("member-os-user-existing-name") as HTMLInputElement;
  expect(field.value).toBe("");
  expect(commandLines(m)).toEqual([]);
  await typeInto(field, "dana");
  expect(commandLines(m)).toEqual([`${COMMANDS.enable} --existing-user dana`]);
  await click(runButtons(m)[0]);
  expect(posts).toEqual([{ action: "enable", osUser: "dana", existing: true }]);
});

it("offers no existing user where no candidates come (a container), only a new one", async () => {
  answers = [picker({ candidates: undefined })];
  const m = await mount();
  expect(optionValues(m)).toEqual(["office", "new"]);
  await pick(m, "new");
  expect(commandLines(m)).toEqual([`${COMMANDS.enable} --user isomux-mia`]);
});

it("Copy copies the command with the pick", async () => {
  answers = [picker()];
  const m = await mount();
  await pick(m, "existing:bob");
  // The Copy button beside the command line.
  const copy = m
    .q("member-os-user-command")
    ?.parentElement?.querySelector<HTMLButtonElement>("button");
  expect(copy ? copy.tagName : null).toBe("BUTTON");
  await click(copy!);
  expect(copied).toEqual([`${COMMANDS.enable} --existing-user bob`]);
});

// Task 04b00bcd: the section hint says their agents cannot read the
// office's files; a root-capable account can, so the hint goes where the
// root-capable warning shows (in every state that carries rootCapable).
it("on: says an adopted user is the person's own, and warns only for a root-capable one", async () => {
  const osUser = { name: "bob", uid: 1001 };
  const stateOf = async (over: Partial<MemberOsUserWire>) => {
    answers = [view({ state: "on", osUser, ...over })];
    const m = await mount();
    expect(m.q("member-os-user-state")?.dataset.state).toBe(over.state ?? "on");
    const out = {
      adopted: m.q("member-os-user-state")?.dataset.adopted ?? null,
      warning: m.q("member-os-user-root-capable") !== null,
      hint: m.q("member-os-user-hint") !== null,
      lines: commandLines(m),
      picker: pickOf(m) !== null,
    };
    m.rendered.unmount();
    return out;
  };
  expect(await stateOf({})).toEqual({
    adopted: null,
    warning: false,
    hint: true,
    lines: [COMMANDS.disable],
    picker: false,
  });
  expect(await stateOf({ adopted: true })).toEqual({
    adopted: "true",
    warning: false,
    hint: true,
    lines: [COMMANDS.disable],
    picker: false,
  });
  expect(await stateOf({ adopted: true, rootCapable: true })).toEqual({
    adopted: "true",
    warning: true,
    hint: false,
    lines: [COMMANDS.disable],
    picker: false,
  });
  // Not only "on": a root-capable account that is not ready yet gets the
  // warning, so not the hint; a plain one that is not ready keeps the hint.
  const notReady = async (over: Partial<MemberOsUserWire>) => {
    const { warning, hint } = await stateOf({ state: "not_ready", ...over });
    return { warning, hint };
  };
  expect(await notReady({ adopted: true, rootCapable: true })).toEqual({
    warning: true,
    hint: false,
  });
  expect(await notReady({ adopted: true })).toEqual({
    warning: false,
    hint: true,
  });
});

// Task 77b253f0: one status row while the state can change.
const all = (m: Awaited<ReturnType<typeof mount>>, id: string) => [
  ...m.rendered.container.querySelectorAll<HTMLElement>(
    `[data-testid="${id}"]`,
  ),
];
// What a transition must not show beside its status row.
const transitionLeaks = (m: Awaited<ReturnType<typeof mount>>) => ({
  state: m.q("member-os-user-state") !== null,
  // The rows that each said part of a transition before.
  oldRows:
    all(m, "member-os-user-attempt").length +
    all(m, "member-os-user-waiting").length,
  commands: commandLines(m).length,
  // Copy and Run are the section's only buttons.
  buttons: m.rendered.container.querySelectorAll("button").length,
  passwords: passwordFields(m).length,
  commandHint: m.q("member-os-user-command-hint") !== null,
  picker: pickOf(m) !== null,
  adopted: all(m, "member-os-user-adopted").length,
});
const NO_LEAKS = {
  state: false,
  oldRows: 0,
  commands: 0,
  buttons: 0,
  passwords: 0,
  commandHint: false,
  picker: false,
  adopted: 0,
};

it("while a command runs or the files move, shows one running row alone: no state line, command, Copy, Run, hint or picker", async () => {
  const bob = { name: "bob", uid: 1001 };
  const cases: { name: string; over: Partial<MemberOsUserWire> }[] = [
    // A turn-on from off, with the picker that off shows.
    {
      name: "enable running",
      over: picker({
        commandHint: "container_name",
        run: "password",
        attempt: { action: "enable", status: "running", at: 1 },
      }),
    },
    {
      name: "disable running",
      over: {
        state: "on",
        osUser: bob,
        adopted: true,
        commandHint: "container_name",
        run: "password",
        attempt: { action: "disable", status: "running", at: 1 },
      },
    },
    {
      name: "moving, no attempt",
      over: {
        state: "moving",
        osUser: bob,
        adopted: true,
        commandHint: "container_name",
        run: "no_password",
      },
    },
    {
      name: "moving, enable running",
      over: {
        state: "moving",
        osUser: bob,
        commandHint: "container_name",
        run: "no_password",
        attempt: { action: "enable", status: "running", at: 1 },
      },
    },
  ];
  const texts: Record<string, string> = {};
  for (const { name, over } of cases) {
    answers = [view(over)];
    const m = await mount();
    // The enabling condition: the supported section rendered.
    expect({ name, section: m.q("member-os-user") !== null }).toEqual({
      name,
      section: true,
    });
    expect({ name, kinds: statusKinds(m) }).toEqual({
      name,
      kinds: ["running"],
    });
    expect({ name, leaks: transitionLeaks(m) }).toEqual({
      name,
      leaks: NO_LEAKS,
    });
    texts[name] = m.q("member-os-user-status")?.textContent ?? "";
    m.rendered.unmount();
  }
  // The row says which way it goes: the attempt's action names it, a move
  // with no attempt has its own line.
  expect(texts["enable running"]).not.toBe("");
  expect(texts["disable running"]).not.toBe(texts["enable running"]);
  expect(texts["moving, enable running"]).toBe(texts["enable running"]);
  expect(texts["moving, no attempt"]).not.toBe(texts["enable running"]);
  expect(texts["moving, no attempt"]).not.toBe(texts["disable running"]);
});

it("keeps the root-capable warning while the command runs", async () => {
  answers = [
    view({
      state: "on",
      osUser: { name: "bob", uid: 1001 },
      adopted: true,
      rootCapable: true,
      attempt: { action: "disable", status: "running", at: 1 },
    }),
  ];
  const m = await mount();
  expect(statusKinds(m)).toEqual(["running"]);
  expect(m.q("member-os-user-root-capable")).not.toBeNull();
});

it("an adopted user's hint sits in each disable command's block, and nowhere without one", async () => {
  const bob = { name: "bob", uid: 1001 };
  // The command lines in the smallest block around each hint.
  const hintBlocks = (m: Awaited<ReturnType<typeof mount>>) =>
    all(m, "member-os-user-adopted").map((hint) => {
      let el: HTMLElement | null = hint.parentElement;
      while (el && !el.querySelector('[data-testid="member-os-user-command"]'))
        el = el.parentElement;
      return [
        ...(el?.querySelectorAll<HTMLElement>(
          '[data-testid="member-os-user-command"]',
        ) ?? []),
      ].map((c) => c.textContent);
    });
  const DISABLE_MOVED = `${COMMANDS.disable} --delete-moved-home`;
  const cases: {
    name: string;
    over: Partial<MemberOsUserWire>;
    blocks: string[][];
  }[] = [
    { name: "on", over: { state: "on" }, blocks: [[COMMANDS.disable]] },
    // Enable and disable both show: the hint goes with disable only.
    {
      name: "not ready",
      over: { state: "not_ready" },
      blocks: [[COMMANDS.disable]],
    },
    // The copy-only disable of a member who came with a move.
    {
      name: "moved in",
      over: {
        state: "not_ready",
        movedIn: true,
        commands: { enable: COMMANDS.enable, disable: DISABLE_MOVED },
      },
      blocks: [[DISABLE_MOVED]],
    },
    // No disable command, no hint.
    { name: "no commands", over: { state: "on", commands: null }, blocks: [] },
  ];
  for (const { name, over, blocks } of cases) {
    answers = [
      view({ osUser: bob, adopted: true, run: "no_password", ...over }),
    ];
    const m = await mount();
    expect({
      name,
      adopted: m.q("member-os-user-state")?.dataset.adopted,
    }).toEqual({ name, adopted: "true" });
    expect({ name, blocks: hintBlocks(m) }).toEqual({ name, blocks });
    m.rendered.unmount();
  }
});

// The failure row: the row's own text, without the folded details.
const failureShort = (m: Awaited<ReturnType<typeof mount>>) => {
  const row = m.q("member-os-user-status");
  if (!row) return null;
  const copy = row.cloneNode(true) as HTMLElement;
  copy
    .querySelector('[data-testid="member-os-user-attempt-details"]')
    ?.remove();
  return copy.textContent ?? "";
};
const failedView = (message: string | undefined) =>
  view({
    officeOsUser: "svc-office",
    attempt: {
      action: "enable",
      status: "failed",
      at: 1,
      ...(message === undefined ? {} : { message }),
    },
  });
// The row's text around an empty message, and the clip.
const FRAME = t("settings.osUser.failedWith", { message: "" }).length;
const CLIP = 200;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it("a failure with many reasons shows the state line and the first reason only, with the rest in closed details", async () => {
  // As member-hosts.ts joins the trusted-check failures.
  const reasons = Array.from(
    { length: 300 },
    (_, i) =>
      `private-agent-write at /home/office/isomux/node_modules/pkg/file-${i}.d.ts: the agent user can write it`,
  );
  answers = [failedView(reasons.join("; "))];
  const m = await mount();
  // The state stays: a failure is not a transition.
  expect(m.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(statusKinds(m)).toEqual(["failed"]);
  const row = m.q("member-os-user-status")!;
  expect(row.getAttribute("role")).toBe("alert");
  const short = failureShort(m)!;
  expect(short).toContain(reasons[0]);
  expect(short).not.toContain("file-1.d.ts");
  expect(short.length).toBeLessThanOrEqual(FRAME + CLIP + 1);
  const details = all(m, "member-os-user-attempt-details");
  expect(details.length).toBe(1);
  expect(details[0].tagName).toBe("DETAILS");
  expect((details[0] as HTMLDetailsElement).open).toBe(false);
  const full = details[0].textContent ?? "";
  expect(full).toContain(reasons[1]);
  expect(full).toContain(reasons[299]);
  // One reason per line, not the joined wall.
  expect(full).not.toContain(`; ${reasons[1]}`);
});

it("clips one long reason, cuts at the first line, and never splits a character", async () => {
  const cases: { name: string; message: string; first: string }[] = [
    {
      name: "one long reason",
      message: "x".repeat(600),
      first: "x".repeat(50),
    },
    {
      name: "two lines",
      message: "the runner did not start\nstack line 1\nstack line 2",
      first: "the runner did not start",
    },
    // A cut at any count of UTF-16 units splits one of these two.
    { name: "emoji even", message: "😀".repeat(300), first: "😀" },
    { name: "emoji odd", message: `a${"😀".repeat(300)}`, first: "a😀" },
  ];
  for (const { name, message, first } of cases) {
    answers = [failedView(message)];
    const m = await mount();
    const short = failureShort(m) ?? "";
    expect({ name, kinds: statusKinds(m) }).toEqual({
      name,
      kinds: ["failed"],
    });
    expect({ name, first: short.includes(first) }).toEqual({
      name,
      first: true,
    });
    // In characters: the clip counts code points.
    expect({
      name,
      bounded: Array.from(short).length <= FRAME + CLIP + 1,
    }).toEqual({
      name,
      bounded: true,
    });
    expect({ name, lone: LONE_SURROGATE.test(short) }).toEqual({
      name,
      lone: false,
    });
    expect({ name, short: short.includes("stack line") }).toEqual({
      name,
      short: false,
    });
    const details = all(m, "member-os-user-attempt-details");
    expect({ name, details: details.length }).toEqual({ name, details: 1 });
    expect({
      name,
      full: details[0]?.textContent?.includes(
        message.split("\n")[1] ?? message,
      ),
    }).toEqual({ name, full: true });
    m.rendered.unmount();
  }
});

it("a short failure shows whole with no details, and a failure with no message or a stop shows its line", async () => {
  answers = [failedView("the member's runner is not connected")];
  const short = await mount();
  expect(statusKinds(short)).toEqual(["failed"]);
  expect(failureShort(short)).toContain("the member's runner is not connected");
  expect(all(short, "member-os-user-attempt-details").length).toBe(0);
  short.rendered.unmount();

  const lines = new Set<string>();
  for (const attempt of [
    { action: "enable" as const, status: "failed" as const, at: 1 },
    { action: "enable" as const, status: "stopped" as const, at: 1 },
  ]) {
    answers = [view({ attempt })];
    const m = await mount();
    expect({
      s: attempt.status,
      state: m.q("member-os-user-state")?.dataset.state,
    }).toEqual({ s: attempt.status, state: "off" });
    expect({ s: attempt.status, kinds: statusKinds(m) }).toEqual({
      s: attempt.status,
      kinds: ["failed"],
    });
    expect(m.q("member-os-user-status")?.getAttribute("role")).toBe("alert");
    expect(all(m, "member-os-user-attempt-details").length).toBe(0);
    lines.add(failureShort(m) ?? "");
    m.rendered.unmount();
  }
  expect(lines.size).toBe(2);
  expect(lines.has("")).toBe(false);
});

it("a Copy after a failure shows the wait, not the old failure", async () => {
  jest.useFakeTimers();
  answers = [failedView("the member's runner is not connected")];
  const m = await mount();
  expect(statusKinds(m)).toEqual(["failed"]);
  const copy = m
    .q("member-os-user-command")
    ?.parentElement?.querySelector<HTMLButtonElement>("button");
  expect(copy ? copy.tagName : null).toBe("BUTTON");
  await click(copy!);
  expect(copied).toEqual([COMMANDS.enable]);
  expect(statusKinds(m)).toEqual(["waiting"]);
  expect(all(m, "member-os-user-attempt-details").length).toBe(0);
  expect(commandLines(m)).toEqual([COMMANDS.enable]);
});
