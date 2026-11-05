import { createContext } from "react";

// The lobby's props take clicks. False while the office state loads
// (LobbyScene's `loading`): the record player and the star jar draw as they
// will, with nothing to press.
export const LobbyLiveCtx = createContext(true);
