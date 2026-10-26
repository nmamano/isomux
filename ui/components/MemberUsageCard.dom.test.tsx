import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { MemberUsageCard } = await import("./MemberUsageCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { getMemberUsageLayout } = await import("../device-settings.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const t = translatorFor("en").t;

const STATUS_PATH = "/api/office/member-usage-status";

// The provider a status request names, or null for another request.
function statusProvider(method: string, path: string): string | null {
  const url = new URL(path, "http://office.test");
  if (method !== "GET" || url.pathname !== STATUS_PATH) return null;
  return url.searchParams.get("provider") ?? "all";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const NEVER = new Promise<never>(() => {});

const slots = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll("[data-usage-provider]")].map((slot) => ({
    provider: slot.getAttribute("data-usage-provider"),
    loading: slot.hasAttribute("data-loading"),
  }));
const slot = (view: { container: HTMLElement }, provider: string) =>
  view.container.querySelector(`[data-usage-provider="${provider}"]`);
// Shown to the member: not inside a held (hidden) block, and says something.
const shown = (node: Element | null) =>
  node !== null &&
  node.closest("[data-reserved], [aria-hidden='true']") === null &&
  (node.textContent ?? "").trim().length > 0;

// The member usage cap switch and member share (task 6de8f530), on the office
// half of Connections: they round-trip through the version-guarded settings
// PUT, which carries only these fields (an absent name keeps it). The share
// select shows while the switch is on, and the status lines show once it is
// saved on. The status has its own route, read per provider (task d13eacc4).
let enabled = false;
let share = 80;
let savedBody: Record<string, unknown> | null = null;
const statusRequests: string[] = [];
setApiShim(async (method, path, body) => {
  const provider = statusProvider(method, path);
  if (provider) {
    statusRequests.push(provider);
    if (!enabled) return { memberUsageStatus: [] };
    return {
      memberUsageStatus:
        provider === "claude"
          ? [
              {
                provider: "claude",
                state: "weekly",
                usedPercent: 41.6,
                linePercent: (share * 4) / 7,
              },
            ]
          : [{ provider: "codex", state: "failed" }],
    };
  }
  if (path === "/api/office/settings" && method === "GET")
    return {
      name: "Office name",
      version: enabled ? "2" : "1",
      memberUsageCap: enabled,
      memberUsageShare: share,
    };
  if (path === "/api/office/settings" && method === "PUT") {
    savedBody = body as Record<string, unknown>;
    enabled = savedBody.memberUsageCap === true;
    share = savedBody.memberUsageShare as number;
    return undefined;
  }
  throw new Error(`no shim for ${method} ${path}`);
});

afterAll(() => {
  setApiShim(null);
});

it("saves the switch and share with the settings and shows one status line per provider once on", async () => {
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.queryByText(/Claude/)).toBeNull();
  // Off, the card reads no provider.
  expect(statusRequests).toEqual([]);

  await act(async () => fireEvent.click(box));
  const select = view.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("80");
  await act(async () => fireEvent.change(select, { target: { value: "70" } }));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  // Only its own fields and the version: no name, and no `prompt`, the old
  // field the server refuses since task 744fa64a.
  expect(savedBody).toEqual({
    version: "1",
    memberUsageCap: true,
    memberUsageShare: 70,
  });
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe("70");
  // The use rounded, the line to one decimal, and a line for each provider.
  // Read per provider once saved on.
  expect([...statusRequests].sort()).toEqual(["claude", "codex"]);
  // The use rounded, the line to one decimal (day 4 of 7 at 70%), and a line
  // for each provider.
  expect(view.getByText(/Claude/).textContent).toContain("42");
  expect(view.getByText(/Claude/).textContent).toContain("40");
  expect(view.getByText(/Codex/)).toBeTruthy();
  expect(slots(view)).toEqual([
    { provider: "claude", loading: false },
    { provider: "codex", loading: false },
  ]);

  // Saved off: the status lines go, and no provider is read again.
  const readsWhileOn = statusRequests.length;
  await act(async () => fireEvent.click(view.getByRole("checkbox")));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(slots(view)).toEqual([]);
  expect(view.queryByText(/Claude/)).toBeNull();
  expect(statusRequests.length).toBe(readsWhileOn);
  view.unmount();
});

it("reserves the card frame, with the switch neither on nor off and writes disabled, until settings arrive", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  setApiShim(async (method, path) =>
    statusProvider(method, path) ? NEVER : pending,
  );
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  const frame = view.container.querySelector('section[aria-busy="true"]');
  expect(frame?.tagName).toBe("SECTION");
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(box.indeterminate).toBe(true);
  const buttons = view.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () =>
    resolve({ version: "1", memberUsageCap: true, memberUsageShare: 80 }),
  );
  expect(
    view.container.querySelector('section[aria-busy="false"]')?.tagName,
  ).toBe("SECTION");
  expect(box.disabled).toBe(false);
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(true);
  view.unmount();
});

for (const outcome of ["failed", "unsupported"] as const) {
  it(`removes the reserved card after ${outcome} settings`, async () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    setApiShim(async () => pending);
    const view = render(onLanguage(null, createElement(MemberUsageCard)));
    expect(
      view.container.querySelector('section[aria-busy="true"]')?.tagName,
    ).toBe("SECTION");
    await act(async () => {
      if (outcome === "failed") reject(new Error("unavailable"));
      else resolve({ version: "1" });
    });
    expect(view.container.childElementCount).toBe(0);
    view.unmount();
  });
}

it("holds the share row and status lines it last showed on this device while settings load", async () => {
  const mount = () => render(onLanguage(null, createElement(MemberUsageCard)));
  // The status space while settings load: the held lines, and the line that
  // says the settings load, which may take the place of one of them.
  const held = (view: ReturnType<typeof mount>) => ({
    shares: view.container.querySelectorAll("[data-reserved] select").length,
    lines:
      view.container.querySelectorAll("[data-reserved] p").length +
      view.queryAllByRole("status").length,
  });
  let resolve!: (value: unknown) => void;
  // Only Claude has an office sign-in.
  setApiShim(async (method, path) => {
    const provider = statusProvider(method, path);
    if (provider)
      return {
        memberUsageStatus:
          provider === "claude"
            ? [{ provider: "claude", state: "no_limit" }]
            : [],
      };
    return new Promise((done) => {
      resolve = done;
    });
  });

  // A device that never loaded the card holds the switched-on layout.
  window.localStorage.clear();
  let view = mount();
  expect(held(view)).toEqual({ shares: 1, lines: 2 });
  for (const node of view.container.querySelectorAll("[data-reserved]"))
    expect(node.getAttribute("aria-hidden")).toBe("true");
  await act(async () =>
    resolve({ version: "1", memberUsageCap: true, memberUsageShare: 80 }),
  );
  expect(view.container.querySelector("[data-reserved]")).toBeNull();
  expect(slots(view)).toEqual([{ provider: "claude", loading: false }]);
  expect(getMemberUsageLayout()).toEqual({ share: true, status: 1 });
  view.unmount();

  // The next load holds what this one showed: the share row and one line.
  view = mount();
  expect(held(view)).toEqual({ shares: 1, lines: 1 });
  await act(async () =>
    resolve({ version: "1", memberUsageCap: false, memberUsageShare: 80 }),
  );
  view.unmount();

  // Switched off, the card showed neither.
  view = mount();
  expect(view.container.querySelector("[data-reserved]")).toBeNull();
  view.unmount();
});

// Task 32c25445: the Office and Room panes keep Save live with nothing
// changed, so a click always answers. This card does the same.
it("saves and says so when Save is clicked with nothing changed", async () => {
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, path, body) => {
    if (statusProvider(method, path)) return { memberUsageStatus: [] };
    if (method === "PUT") {
      writes.push(body as Record<string, unknown>);
      return undefined;
    }
    return { version: "1", memberUsageCap: true, memberUsageShare: 80 };
  });
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  const buttons = view.getAllByRole("button") as HTMLButtonElement[];
  const save = buttons[buttons.length - 1];
  expect(save.disabled).toBe(false);
  const before = save.textContent;
  await act(async () => fireEvent.click(save));
  expect(writes).toEqual([
    {
      version: "1",
      memberUsageCap: true,
      memberUsageShare: 80,
    },
  ]);
  expect(save.textContent).not.toBe(before);
  view.unmount();
});

// Task d13eacc4: the settings answer without the provider reads, which can
// take seconds. The card says it loads in words, and each provider's line
// loads on its own once the settings are in.
it("says in words that the settings load, and stops once they arrive", async () => {
  const settings = deferred<unknown>();
  setApiShim(async (method, path) =>
    statusProvider(method, path) ? NEVER : settings.promise,
  );
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  const card = view.container.querySelector("[data-member-usage-card]")!;
  const status = card.querySelectorAll('[role="status"]');
  expect(status.length).toBe(1);
  expect(shown(status[0])).toBe(true);
  await act(async () =>
    settings.resolve({
      version: "1",
      memberUsageCap: false,
      memberUsageShare: 80,
    }),
  );
  expect(view.queryAllByRole("status")).toEqual([]);
  view.unmount();
});

it("lets the owner use the switch and share while each provider's line loads, and fills each line on its own", async () => {
  const answers = {
    claude: deferred<unknown>(),
    codex: deferred<unknown>(),
  };
  const requested: string[] = [];
  setApiShim(async (method, path) => {
    const provider = statusProvider(method, path);
    if (provider) {
      requested.push(provider);
      return answers[provider as keyof typeof answers].promise;
    }
    return { version: "1", memberUsageCap: true, memberUsageShare: 80 };
  });
  window.localStorage.clear();
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});

  // One request per provider, both still out.
  expect([...requested].sort()).toEqual(["claude", "codex"]);
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(false);
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(true);
  expect((view.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    false,
  );
  expect(
    (view.getByRole("button", { name: t("common.save") }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  // Each provider has its own loading line, in the order the rows show.
  expect(slots(view)).toEqual([
    { provider: "claude", loading: true },
    { provider: "codex", loading: true },
  ]);
  expect(shown(slot(view, "claude"))).toBe(true);
  expect(shown(slot(view, "codex"))).toBe(true);
  const codexLoading = slot(view, "codex")!.textContent;

  // Claude's row arrives while Codex still loads.
  await act(async () =>
    answers.claude.resolve({
      memberUsageStatus: [
        {
          provider: "claude",
          state: "weekly",
          usedPercent: 41.6,
          linePercent: (80 * 4) / 7,
        },
      ],
    }),
  );
  expect(slots(view)).toEqual([
    { provider: "claude", loading: false },
    { provider: "codex", loading: true },
  ]);
  expect(slot(view, "claude")!.textContent).toContain("42");
  expect(slot(view, "codex")!.textContent).toBe(codexLoading);

  // Codex has no office sign-in: its line goes.
  await act(async () => answers.codex.resolve({ memberUsageStatus: [] }));
  expect(slots(view)).toEqual([{ provider: "claude", loading: false }]);
  expect(getMemberUsageLayout()).toEqual({ share: true, status: 1 });
  view.unmount();
});

it("drops a provider's line without an error when its request fails", async () => {
  setApiShim(async (method, path) => {
    const provider = statusProvider(method, path);
    if (provider === "claude")
      throw new ApiError(404, "not_found", "No such route");
    if (provider === "codex")
      return { memberUsageStatus: [{ provider: "codex", state: "failed" }] };
    return { version: "1", memberUsageCap: true, memberUsageShare: 80 };
  });
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  expect(slots(view)).toEqual([{ provider: "codex", loading: false }]);
  expect(view.queryByRole("alert")).toBeNull();
  view.unmount();
});

it("reads the lines again after a save, and an answer from before the save cannot replace a newer one", async () => {
  let savedShare = 80;
  const answers: { provider: string; answer: ReturnType<typeof deferred> }[] =
    [];
  setApiShim(async (method, path, body) => {
    const provider = statusProvider(method, path);
    if (provider) {
      const answer = deferred<unknown>();
      answers.push({ provider, answer });
      return answer.promise;
    }
    if (method === "PUT") {
      savedShare = (body as { memberUsageShare: number }).memberUsageShare;
      return undefined;
    }
    return {
      version: String(savedShare),
      memberUsageCap: true,
      memberUsageShare: savedShare,
    };
  });
  const claudeRow = (linePercent: number) => ({
    memberUsageStatus: [
      { provider: "claude", state: "weekly", usedPercent: 10, linePercent },
    ],
  });
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  expect(answers.map((a) => a.provider).sort()).toEqual(["claude", "codex"]);
  const before = answers.slice();

  await act(async () =>
    fireEvent.change(view.getByRole("combobox"), { target: { value: "70" } }),
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  expect(savedShare).toBe(70);
  const after = answers.slice(2);
  expect(after.map((a) => a.provider).sort()).toEqual(["claude", "codex"]);
  const of = (list: typeof answers, provider: string) =>
    list.find((a) => a.provider === provider)!.answer;

  // The new answer at 70% (day 4 of 7: 40%) comes first, then the old one.
  await act(async () => of(after, "claude").resolve(claudeRow(40)));
  expect(slot(view, "claude")!.textContent).toContain("40");
  await act(async () => of(before, "claude").resolve(claudeRow(45.7)));
  expect(slot(view, "claude")!.textContent).toContain("40");
  expect(slot(view, "claude")!.textContent).not.toContain("45.7");
  // An old answer does not fill a line whose new answer is still out.
  await act(async () =>
    of(before, "codex").resolve({
      memberUsageStatus: [{ provider: "codex", state: "failed" }],
    }),
  );
  expect(slots(view)).toEqual([
    { provider: "claude", loading: false },
    { provider: "codex", loading: true },
  ]);
  view.unmount();
});
