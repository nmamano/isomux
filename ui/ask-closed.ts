// The asks the server closed for this store (ask_removed), for a held answer
// whose card unmounts on that same push: the card's flush runs with the
// state of its last render, so it reads this set, filled before the
// dispatch, instead of the store. One set per StoreProvider.

import { createContext, useContext } from "react";

export const AsksClosedHere = createContext<ReadonlySet<string>>(new Set());

export function useAsksClosedHere(): ReadonlySet<string> {
  return useContext(AsksClosedHere);
}
