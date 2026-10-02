import { expect, test } from "bun:test";

// The popup saves drafts and the worker confirms codes, in separate contexts,
// in any order. Session storage here can hold a write in flight.
const store = new Map<string, unknown>();
let hold: Promise<void> | null = null;
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    session: {
      get: async (key: string) =>
        store.has(key) ? { [key]: structuredClone(store.get(key)) } : {},
      set: async (value: Record<string, unknown>) => {
        const pending = hold;
        if (pending) await pending;
        for (const [key, item] of Object.entries(value))
          store.set(key, structuredClone(item));
      },
    },
  },
};
const { confirmPairedCode, readPairingDraft, savePairingDraft } =
  await import("./pairing-draft");

test("a confirmation never erases a draft typed since, in any order", async () => {
  const office = "https://office.example.com";
  // Saved, then confirmed: done.
  store.clear();
  await savePairingDraft({ office, code: "a" });
  await confirmPairedCode("a");
  expect(await readPairingDraft()).toEqual({ office: "", code: "" });
  // Confirmed, then a new code typed: kept.
  await savePairingDraft({ office, code: "b" });
  expect(await readPairingDraft()).toEqual({ office, code: "b" });
  // The new code is saved while the confirmation of the old one is in flight.
  store.clear();
  await savePairingDraft({ office, code: "a" });
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const confirming = confirmPairedCode("a");
  hold = null;
  await savePairingDraft({ office, code: "b" });
  release();
  await confirming;
  expect(await readPairingDraft()).toEqual({ office, code: "b" });
});
