import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));
const message = (id: string) => ({
  id,
  kind: "user" as const,
  userId: "other",
  userName: "Sam",
  content: id,
  attachments: [],
  timestamp: 1,
});
const settleRead = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
it("marks a short visible list read, pauses in history and hidden tabs, and resumes at the bottom", async () => {
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const reads: string[] = [];
  setApiShim(async (_method, path, body) => {
    if (path === "/api/members-chat/read")
      reads.push((body as { lastReadId: string }).lastReadId);
    return { readPointer: reads.at(-1), unread: 0 };
  });
  function panel(id: string, mobile = false) {
    return onLanguage("en", createElement(MembersChatPanel), {
      isMobile: mobile,
      membersChat: {
        loaded: true,
        messages: [message(id)],
        hasMore: false,
        unread: 1,
        readPointer: null,
      },
    });
  }
  const view = render(panel("01"));
  await settleRead();
  expect(reads).toEqual(["01"]);
  const list = view.container.querySelector(
    "[data-members-chat-list]",
  ) as HTMLDivElement;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 500 },
  });
  list.scrollTop = 100;
  fireEvent.scroll(list);
  view.rerender(panel("02"));
  await settleRead();
  expect(reads).toEqual(["01"]);
  expect(list.scrollTop).toBe(100);
  visibility = "hidden";
  fireEvent(document, new Event("visibilitychange"));
  list.scrollTop = 1500;
  fireEvent.scroll(list);
  await settleRead();
  expect(reads).toEqual(["01"]);
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  await settleRead();
  expect(reads).toEqual(["01", "02"]);
  view.rerender(panel("03", true));
  await settleRead();
  expect(reads).toEqual(["01", "02", "03"]);
  delete (document as unknown as Record<string, unknown>).visibilityState;
});
