// How a send failure renders: sendFailureText's string, with the help email
// shown as a value (AGENTS.md "UI rules").
import type { ReactNode } from "react";
import { withData } from "./components/Data.tsx";
import { ENTERPRISE_HELP_EMAIL } from "./send-failure.ts";

export function sendFailureNode(text: string): ReactNode {
  return withData(text, [ENTERPRISE_HELP_EMAIL]);
}
