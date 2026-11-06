// Recording mode through the real App and store (task 6e08239a): the store
// feeds the rules (the member's word list from their own record, the office
// name row by default, the floors as other offices). The setup is in
// ui/test-support/inbox-fixture.tsx (member "member", office "Test Office",
// room "First room").

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { boot, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const { currentRedactor, setRecording } = await import("./recording-mode.ts");

type RecordingWord = import("../shared/recording-redact.ts").RecordingWord;

setUpInboxTests();
afterEach(() => setRecording(false));

// The text the page draws, without style sheets.
function drawnText(): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.parentElement?.closest("style") === null) out.push(n.nodeValue ?? "");
  return out.join("\n");
}

const flush = async () => {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

async function selfRecord(recordingWords?: RecordingWord[]) {
  await act(async () =>
    shimEmit({
      type: "user_self_updated",
      user: {
        ...selfUserRecord(null),
        id: "u1",
        name: "member",
        role: "member",
        ...(recordingWords ? { recordingWords } : {}),
      },
    } as never),
  );
  await flush();
}

it("hides the office name by default, then the member's own words, which replace the default", async () => {
  await boot();
  expect(drawnText()).toContain("First room");
  expect(document.title).toContain("Test Office");

  await act(async () => setRecording(true));
  await flush();
  // No list saved: the default row is the office name.
  expect(document.title).not.toContain("Test Office");
  expect(drawnText()).toContain("First room");

  await selfRecord([{ word: "First room", standIn: "Room A" }]);
  expect(drawnText()).not.toContain("First room");
  expect(drawnText()).toContain("Room A");
  // The member's list has no office row: the name shows.
  expect(document.title).toContain("Test Office");

  // A record with no list falls back to the default again.
  await selfRecord();
  expect(drawnText()).toContain("First room");
  expect(document.title).not.toContain("Test Office");

  await act(async () => setRecording(false));
  await flush();
  expect(document.title).toContain("Test Office");
});

it("takes the office's floors as other offices", async () => {
  await boot();
  await act(async () => setRecording(true));
  await act(async () =>
    shimEmit({
      type: "floors_updated",
      floors: [
        {
          id: "f1",
          url: "https://hq.acmeoffice.org",
          name: "Acme HQ",
          addedAt: 1,
        },
      ],
    } as never),
  );
  await flush();
  const redact = currentRedactor()!;
  expect(redact("Acme HQ")).not.toContain("Acme");
  expect(redact("https://hq.acmeoffice.org/x")).not.toContain("acmeoffice");
});
