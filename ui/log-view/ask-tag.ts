// The built-in answers of an ask card (task 1466ea8b): a tag on the reply
// field that names what the field's text goes with. "file" is Postpone with
// its "File as a task" suggestion: the ask is filed on the board.
import type { AskTag } from "../../shared/types.ts";

export type AskCardTag = AskTag | "file";
