// Metadata key on the error log entry that ends a failed message edit. Its
// value is the edited text, so the chat can offer to put the text back in the
// composer: the text lives in the log where the failure shows.
export const FAILED_EDIT_TEXT_KEY = "failedEditText";

export function failedEditText(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const text = metadata?.[FAILED_EDIT_TEXT_KEY];
  return typeof text === "string" && text.length > 0 ? text : null;
}
