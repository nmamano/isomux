import { createContext } from "react";

// DOM fixtures can omit static scenery while exercising the real office controls.
// Production and decoration tests keep the full scene through this default.
export const SceneDecorationContext = createContext(true);
