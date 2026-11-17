// One save footer for every Settings part that saves (task f0d50877): the
// Office and Access sections. Office drew its own Save row at the end of its
// fields, with Save enabled before anything changed; Access had a Save inside
// its card. Both now use the footer every part uses, under the section's
// padded box (ui/test-support/save-footer-contract.ts).

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const { viewer } = await import("./test-support/claude-limits-fixture.tsx");
const { expectFooterPlacement, expectSaveCycle, mountSettingsAt, settle } =
  await import("./test-support/save-footer-contract.ts");

afterAll(() => setApiShim(null));

const OWNER = { ...selfUserRecord(null), id: "owner", name: "Owner" };
const MEMBER = {
  ...selfUserRecord(null),
  id: "u2",
  name: "Bru",
  role: "member" as const,
};

// The office's settings and instructions, each with its version, as the
// server keeps them; the access settings of a self-hosted office.
function shimOffice() {
  window.localStorage.clear();
  const state = { name: null as string | null, prompt: null as string | null };
  const writes: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/office/settings" && method === "GET")
      return { name: state.name, version: `s:${state.name}` };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: state.prompt, version: `i:${state.prompt}` };
    if (path === "/api/office/access" && method === "GET")
      return {
        hosted: false,
        externalAccess: true,
        publicOrigin: "https://office.example",
        boundLoopback: false,
      };
    if (method === "GET") return {};
    writes.push({ method, path, body });
    if (path === "/api/office/settings") {
      if ("name" in b) state.name = (b.name as string | null) || null;
      return undefined;
    }
    if (path === "/api/office/instructions") {
      state.prompt = (b.instructions as string | null) || null;
      return { instructions: state.prompt, version: `i:${state.prompt}` };
    }
    if (path === "/api/office/access")
      return { signInUrl: null, restartRequired: true };
    return {};
  });
  return writes;
}

const formBody = (root: HTMLElement) => {
  const all = root.querySelectorAll<HTMLElement>("[data-settings-form-body]");
  if (all.length !== 1)
    throw new Error(`expected one form body, found ${all.length}`);
  return all[0];
};

it("Office: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  const writes = shimOffice();
  const { view } = mountSettingsAt(
    { kind: "section", section: "office" },
    { users: [OWNER], agents: [] },
  );
  await settle();
  const name = () =>
    formBody(view.container).querySelector<HTMLInputElement>(
      'input:not([type="checkbox"])',
    )!;
  expect(name().readOnly).toBe(false);
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => name().value,
    edit: async (step) => {
      await act(async () => {
        fireEvent.change(name(), { target: { value: `Acme ${step}` } });
      });
    },
  });
  expect(
    writes.filter((w) => w.path === "/api/office/settings").map((w) => w.body),
  ).toEqual([{ name: "Acme 1", version: "s:null" }]);
  view.unmount();
});

it("Office for a member who cannot edit it: no footer", async () => {
  shimOffice();
  const { view } = mountSettingsAt(
    { kind: "section", section: "office" },
    { users: [OWNER, MEMBER], agents: [] },
    { ...viewer([]), userId: MEMBER.id, username: MEMBER.name, role: "member" },
  );
  await settle();
  // The pane is up: its name field shows, read-only.
  expect(
    view
      .getByTestId("settings-content")
      .querySelector<HTMLInputElement>('input:not([type="checkbox"])')
      ?.readOnly,
  ).toBe(true);
  expect(
    view.container.querySelectorAll(
      "[data-settings-footer], [data-settings-save]",
    ).length,
  ).toBe(0);
  view.unmount();
});

it("Access: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  const writes = shimOffice();
  const { view } = mountSettingsAt(
    { kind: "section", section: "access" },
    { users: [OWNER], agents: [] },
  );
  await settle();
  const box = () =>
    formBody(view.container).querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
  expect(box().disabled).toBe(false);
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => box().checked,
    edit: async () => {
      await act(async () => {
        fireEvent.click(box());
      });
    },
  });
  expect(writes.map((w) => [w.method, w.path])).toEqual([
    ["PUT", "/api/office/access"],
  ]);
  view.unmount();
});
