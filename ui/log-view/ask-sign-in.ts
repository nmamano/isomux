// The result of an MCP sign-in that came back to an ask card (task e3d1bc63,
// part 6): /inbox/asks/<askId>?mcpSignIn=<code>, read once at boot. App holds
// it; the card of that ask takes it and shows it.

import { createContext } from "react";

export interface AskSignIn {
  askId: string;
  code: string;
}

export const AskSignInResult = createContext<{
  result: AskSignIn | null;
  take: () => void;
}>({ result: null, take: () => {} });
