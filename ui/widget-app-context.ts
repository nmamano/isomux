import { createContext } from "react";
import type { SendMessageReq } from "../shared/contract-shapes.ts";

// The office opened from a phone's app widget (task d7ac4f73): a message from
// the office composer to the app's agent carries the app and the page the
// member came from. Messages to any other agent do not.
export interface WidgetAppContext {
  agentId: string;
  appContext: NonNullable<SendMessageReq["appContext"]>;
}

export const WidgetAppCtx = createContext<WidgetAppContext | null>(null);
