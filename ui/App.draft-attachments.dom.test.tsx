// The attachments of an unsent chat draft (task bd4caaa2), through the real
// App and store: they stay with the agent's draft while the member is in
// another agent's chat, an upload that ends meanwhile lands in the draft, a
// reload brings them back as it does the text, and the Inbox chat panel shows
// and sends the same ones. The store and persistence rules on their own are in
// ui/store.test.ts and ui/view-persistence.test.ts; the setup is
// ui/test-support/inbox-fixture.tsx.

import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const { saveDraft, saveDraftAttachments, loadUserDraftAttachments } =
  await import("./view-persistence.ts");
const {
  addRanger,
  ask,
  boot,
  chatFromInbox,
  chatPanel,
  inboxButton,
  openFullChat,
  sentMessages,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type Attachment = import("../shared/types.ts").Attachment;

setUpInboxTests();

let uploads: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null = null;
afterEach(() => {
  uploads?.mockRestore();
  uploads = null;
});

const shot: Attachment = {
  filename: "stored-shot.png",
  originalName: "shot.png",
  mediaType: "image/png",
  size: 3,
};
const notes: Attachment = {
  filename: "stored-notes.pdf",
  originalName: "notes.pdf",
  mediaType: "application/pdf",
  size: 5,
};

// The office composer: the agent's full chat is the last textarea, and its
// file input is the hidden one beside it.
const officeComposer = (view: View) => {
  const all = view.container.querySelectorAll("textarea");
  return all[all.length - 1];
};
const officeFileInput = (view: View) => {
  const inputs =
    view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs.length).toBe(1);
  return inputs[0];
};
const shows = (view: View, text: string) =>
  (view.container.textContent ?? "").includes(text);

async function toChat(view: View, agentId: string) {
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, agentId);
}

it("keeps an attachment with the agent's draft while the member is in another agent's chat, lands an upload that ends meanwhile, and sends and clears it", async () => {
  addRanger();
  setAsks([ask("q1", "a1"), ask("q2", "a2")]);
  let finish!: () => void;
  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  uploads = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
  ) => {
    expect(String(url)).toBe("/api/upload/a1");
    await answered;
    return new Response(JSON.stringify({ attachments: [shot] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
  const view = await boot();
  await toChat(view, "a1");
  expect(document.title).toContain("Scout");

  await act(async () =>
    fireEvent.change(officeFileInput(view), {
      target: {
        files: [new File(["png"], "shot.png", { type: "image/png" })],
      },
    }),
  );
  expect(uploads.mock.calls).toHaveLength(1);
  expect(shows(view, "shot.png")).toBe(true);
  expect(shows(view, en["logView.attachUploading"])).toBe(true);
  await act(async () =>
    fireEvent.change(officeComposer(view), {
      target: { value: "with a picture" },
    }),
  );

  // In Ranger's chat, Scout's attachment is not offered; Scout's upload
  // ends there.
  await toChat(view, "a2");
  expect(document.title).toContain("Ranger");
  expect(officeComposer(view).value).toBe("");
  expect(shows(view, "shot.png")).toBe(false);
  await act(async () => {
    finish();
    await answered;
  });
  await act(async () => {});
  expect(shows(view, "shot.png")).toBe(false);

  // Back in Scout's chat: the text and the uploaded attachment, which is
  // also saved for a reload.
  await toChat(view, "a1");
  expect(document.title).toContain("Scout");
  expect(officeComposer(view).value).toBe("with a picture");
  expect(shows(view, "shot.png")).toBe(true);
  expect(shows(view, en["logView.attachUploading"])).toBe(false);
  expect(loadUserDraftAttachments("member")).toEqual({ a1: [shot] });

  await act(async () =>
    fireEvent.keyDown(officeComposer(view), { key: "Enter" }),
  );
  await act(async () => {});
  expect(sentMessages.map((m) => m.path)).toEqual(["/api/agents/a1/messages"]);
  expect(sentMessages[0].body.text).toBe("with a picture");
  expect(sentMessages[0].body.attachments).toEqual([shot]);
  expect(shows(view, "shot.png")).toBe(false);
  expect(loadUserDraftAttachments("member")).toEqual({});
});

it("brings a draft's attachments back after a reload, and the Inbox chat panel shows, removes, sends and adds the same ones", async () => {
  setAsks([ask("q1", "a1")]);
  // What the member left in Scout's chat before the reload, and in the chat
  // of an agent that is gone since.
  saveDraft("member", "a1", "see these");
  const saved = (a: Attachment, id: string) => ({
    ...a,
    id,
    uploading: false,
  });
  saveDraftAttachments("member", "a1", [saved(shot, "s1"), saved(notes, "s2")]);
  saveDraftAttachments("member", "gone", [saved(notes, "s3")]);
  const view = await boot();
  expect(loadUserDraftAttachments("member")).toEqual({ a1: [shot, notes] });

  await act(async () => fireEvent.click(inboxButton(view)!));
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-agent="a1"]',
  );
  await act(async () => fireEvent.click(name!));
  const panel = chatPanel(view)!;
  expect(panel.querySelector("textarea")!.value).toBe("see these");
  const figures = () =>
    [...panel.querySelectorAll("figure")].map((f) => ({
      caption: f.querySelector("figcaption")?.textContent,
      img: f.querySelector("img")?.getAttribute("src") ?? null,
    }));
  // An image shows its thumbnail; another file only its name.
  expect(figures()).toEqual([
    { caption: "shot.png", img: "/api/files/a1/stored-shot.png" },
    { caption: "notes.pdf", img: null },
  ]);

  // Removed in the panel: gone from the draft.
  const notesFigure = [...panel.querySelectorAll("figure")].find(
    (f) => f.querySelector("figcaption")?.textContent === "notes.pdf",
  )!;
  await act(async () => fireEvent.click(notesFigure.querySelector("button")!));
  expect(figures().map((f) => f.caption)).toEqual(["shot.png"]);
  expect(loadUserDraftAttachments("member")).toEqual({ a1: [shot] });

  await act(async () => {
    fireEvent.submit(panel.querySelector("form")!);
  });
  await act(async () => {});
  expect(sentMessages.map((m) => m.path)).toEqual(["/api/agents/a1/messages"]);
  expect(sentMessages[0].body.text).toBe("see these");
  expect(sentMessages[0].body.attachments).toEqual([shot]);
  expect(figures()).toEqual([]);
  expect(loadUserDraftAttachments("member")).toEqual({});

  // A pick in the panel goes into the same draft; it takes images only.
  const added: Attachment = {
    ...shot,
    filename: "stored-added.png",
    originalName: "added.png",
  };
  uploads = spyOn(globalThis, "fetch").mockImplementation(
    (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ attachments: [added] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
  );
  await act(async () =>
    fireEvent.change(panel.querySelector('input[type="file"]')!, {
      target: {
        files: [
          new File(["png"], "added.png", { type: "image/png" }),
          new File(["txt"], "notes.txt", { type: "text/plain" }),
        ],
      },
    }),
  );
  await act(async () => {});
  expect(uploads.mock.calls.map((c) => String(c[0]))).toEqual([
    "/api/upload/a1",
  ]);
  expect(figures()).toEqual([
    { caption: "added.png", img: "/api/files/a1/stored-added.png" },
  ]);
  expect(loadUserDraftAttachments("member")).toEqual({ a1: [added] });

  // The full chat has the panel's draft: no text, and the picked image only.
  await openFullChat(view);
  expect(document.title).toContain("Scout");
  expect(officeComposer(view).value).toBe("");
  expect(shows(view, "shot.png")).toBe(false);
  expect(shows(view, "added.png")).toBe(true);
});
