// Settings > Members > a member > Own OS user (task b94dfd25 4c-i). The
// properties:
// - where the root command cannot run, only the reason shows (one line per
//   reason, no command); nothing renders when the read fails or the answer
//   has no support field (an older server);
// - not ready after a move that a stop cut says so, with its own hint over
//   the enable command; a command with the container placeholder adds the
//   hint to name the container;
// - the section shows the state, the last attempt, and the command for the
//   state: enable while off, disable otherwise; Copy copies that command;
// - the page reads again every OS_USER_POLL_MS only while the state can
//   change (an attempt running, or after a Copy until the state changes), and
//   stops on a final state, on unmount and at OS_USER_POLL_CAP_MS;
// - the Claude row follows the office's member token;
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
let tokenSet = false;
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
  if (method === "GET" && path === "/api/office/claude-member-token")
    return { set: tokenSet };
  throw new Error(`unexpected ${method} ${path}`);
});

const savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let copied: string[] = [];
beforeEach(() => {
  answers = [];
  reads = 0;
  posts = [];
  runAnswer = null;
  tokenSet = false;
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

it("shows the enable command while off, and the disable command with the failed attempt's message otherwise", async () => {
  answers = [view()];
  const off = await mount();
  expect(off.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(off.q("member-os-user-command")?.textContent).toBe(COMMANDS.enable);
  expect(off.q("member-os-user-attempt")).toBeNull();
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
  expect(on.q("member-os-user-attempt")?.dataset.status).toBe("failed");
  expect(on.q("member-os-user-attempt")?.textContent).toContain(
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
  expect(m.q("member-os-user-attempt")?.dataset.status).toBe("running");
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
  expect(m.q("member-os-user-waiting")).toBeNull();
  const copy = m.rendered.container.querySelector<HTMLButtonElement>(
    '[data-testid="member-os-user"] button',
  )!;
  await act(async () => {
    fireEvent.click(copy);
  });
  await settle();
  expect(copied).toEqual([COMMANDS.enable]);
  expect(m.q("member-os-user-waiting")).not.toBeNull();
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(2);
  expect(m.q("member-os-user-waiting")).not.toBeNull();
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(3);
  // The command began: the attempt shows, the wait line goes.
  expect(m.q("member-os-user-waiting")).toBeNull();
  expect(m.q("member-os-user-attempt")?.dataset.status).toBe("running");
  await advance(OS_USER_POLL_MS);
  expect(reads).toBe(4);
  expect(m.q("member-os-user-state")?.dataset.state).toBe("off");
  expect(m.q("member-os-user-attempt")).toBeNull();
  // Not waiting again, and no more reads.
  expect(m.q("member-os-user-waiting")).toBeNull();
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

it("the Claude row says whether the member token is set", async () => {
  answers = [view()];
  tokenSet = false;
  const missing = await mount();
  const missingText = missing.q("member-os-user-claude")?.textContent ?? "";
  expect(missingText).toContain(t("settings.osUser.claudeTokenMissing"));
  missing.rendered.unmount();
  tokenSet = true;
  const set = await mount();
  const setText = set.q("member-os-user-claude")?.textContent ?? "";
  expect(setText).toContain(t("settings.osUser.claudeTokenSet"));
  expect(setText).not.toBe(missingText);
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

it("allows no Run while a run goes on", async () => {
  answers = [
    view({
      run: "no_password",
      attempt: { action: "enable", status: "running", at: 1 },
    }),
  ];
  const m = await mount();
  expect(runButtons(m).map((b) => b.disabled)).toEqual([true]);
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
