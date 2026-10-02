// What the member has typed into the popup's pairing form. Both fields are
// usually pasted from the office, and copying the second one closes the popup,
// so the popup keeps them here and fills them back in when it opens again.
//
// Session storage, never local: the code is a short-lived secret, and session
// storage stays in memory, is closed to content scripts and ends with the
// browser.
//
// The popup is the draft's only writer. The worker records the code the office
// confirmed under its own key and never touches the draft, so no interleaving
// of a save and a confirmation can erase what was typed since: a draft that
// still holds the confirmed code reads as empty, any other draft stays.
const DRAFT = "pairingDraft";
const PAIRED = "pairedCode";

export type PairingDraft = { office: string; code: string };

async function read(key: string): Promise<unknown> {
  return (await chrome.storage.session.get(key))[key];
}

export async function pairedCode(): Promise<string> {
  const code = await read(PAIRED);
  return typeof code === "string" ? code : "";
}

export async function readPairingDraft(): Promise<PairingDraft> {
  const stored = await read(DRAFT);
  const draft =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const code = typeof draft.code === "string" ? draft.code : "";
  if (code && code.trim() === (await pairedCode()))
    return { office: "", code: "" };
  return {
    office: typeof draft.office === "string" ? draft.office : "",
    code,
  };
}

export function savePairingDraft(draft: PairingDraft): Promise<void> {
  return chrome.storage.session.set({ [DRAFT]: draft });
}

// The worker, on the office's paired acknowledgement.
export function confirmPairedCode(code: string): Promise<void> {
  return chrome.storage.session.set({ [PAIRED]: code });
}
