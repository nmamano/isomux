import { createContext } from "react";

// The lobby's props take clicks. False while the office state loads
// (LobbyScene's `loading`): the record player and the star jar draw as they
// will, with nothing to press, and the props drawn from the state (the
// plaque, the directory) draw placeholders (placeholder.tsx).
export const LobbyLiveCtx = createContext(true);
