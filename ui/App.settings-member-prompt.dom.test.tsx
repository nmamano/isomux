import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { createElement } = await import("react");
const { versionOf } = await import("../shared/blob-version.ts");
afterAll(() => setApiShim(null));

it("keeps the draft after conflict, reads the current prompt, and retries with its version", async () => {
  // The text is saved through the member's instructions route (task
  // 379ae5db); a PATCH of the record must not carry it.
  const patches: Record<string, unknown>[] = [];
  const recordPatches: Record<string, unknown>[] = [];
  let reads = 0;
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (method === "PUT" && path === "/api/users/Ricky/instructions") {
      const b = body as { instructions: string | null };
      patches.push(b);
      if (patches.length === 1)
        throw new ApiError(409, "version_conflict", "conflict");
      return {
        instructions: b.instructions,
        version: versionOf(b.instructions ?? ""),
      };
    }
    if (method === "PATCH" && path === "/api/users/Ricky") {
      recordPatches.push(body as Record<string, unknown>);
      return { user: {} };
    }
    if (method === "GET" && path === "/api/users/Ricky/instructions") {
      reads++;
      return {
        instructions: "other writer",
        version: versionOf("other writer"),
      };
    }
    return {};
  });
  const self = {
    id: "u1",
    name: "Ricky",
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    tucked: [],
    memberPrompt: "original",
    language: null,
    avatarColor: "#4A90D9",
    avatarVariant: 0,
    role: "owner",
  };
  const state = {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
    users: new Map([["ricky", self]]),
  } as unknown as typeof initialState;
  window.history.replaceState(null, "", "/settings");
  const view = render(
    createElement(StateCtx.Provider, { value: state }, createElement(App, {})),
  );
  await act(async () => {
    fireEvent.change(view.getByDisplayValue("original"), {
      target: { value: "my draft" },
    });
  });
  // A live user refresh must not advance the version of an existing draft.
  view.rerender(
    createElement(
      StateCtx.Provider,
      {
        value: {
          ...state,
          users: new Map([
            ["ricky", { ...self, memberPrompt: "other writer" }],
          ]),
        } as unknown as typeof initialState,
      },
      createElement(App, {}),
    ),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
  });
  expect(reads).toBe(1);
  expect(patches[0].version).toBe(versionOf("original"));
  expect(
    (view.getByDisplayValue("my draft") as HTMLTextAreaElement).readOnly,
  ).toBe(false);
  expect(
    (view.getByDisplayValue("other writer") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
  });
  expect(patches[1]).toEqual({
    instructions: "my draft",
    version: versionOf("other writer"),
  });
  expect(view.queryByDisplayValue("other writer")).toBeNull();
  await act(async () => {
    fireEvent.change(view.getByDisplayValue("my draft"), {
      target: { value: "second draft" },
    });
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
  });
  expect(patches[2]).toEqual({
    instructions: "second draft",
    version: versionOf("my draft"),
  });
  for (const body of recordPatches) {
    expect(Object.keys(body)).not.toContain("memberPrompt");
    expect(Object.keys(body)).not.toContain("instructions");
  }
});
