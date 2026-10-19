// A member's usage note on a connection (integrations loop, slice A4): what
// agents should use it for. One rule for variables, secrets and MCP servers,
// checked at write only, so a stored note never makes its file unreadable.

// UTF-16 units, as the input's maxLength counts them.
export const CONNECTION_NOTE_MAX_LENGTH = 1000;

export type ConnectionNoteCheck =
  | { ok: true; note: string | null }
  | { ok: false; reason: "invalid" | "too_long" };

// null, or a string that is empty after a trim, clears the note. Newline and
// tab are the only control characters a note keeps.
export function checkConnectionNote(note: unknown): ConnectionNoteCheck {
  if (note === null) return { ok: true, note: null };
  if (typeof note !== "string") return { ok: false, reason: "invalid" };
  const trimmed = note.trim();
  if (trimmed.length === 0) return { ok: true, note: null };
  if (trimmed.length > CONNECTION_NOTE_MAX_LENGTH)
    return { ok: false, reason: "too_long" };
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: "invalid" };
  }
  return { ok: true, note: trimmed };
}

// The variable notes to save with `values` (a PUT of the variables): the
// request's when it sent some, otherwise the saved notes of the names that
// remain. A note on a name not in `values` is dropped.
export function nextVariableNotes(
  values: Record<string, string>,
  requested: unknown,
  saved: Record<string, string>,
):
  | { ok: true; notes: Record<string, string> }
  | { ok: false; name: string | null; reason: "invalid" | "too_long" } {
  const notes = Object.create(null) as Record<string, string>;
  if (requested === undefined) {
    for (const [name, note] of Object.entries(saved))
      if (Object.hasOwn(values, name)) notes[name] = note;
    return { ok: true, notes };
  }
  if (!requested || typeof requested !== "object" || Array.isArray(requested))
    return { ok: false, name: null, reason: "invalid" };
  for (const [name, note] of Object.entries(requested)) {
    const checked = checkConnectionNote(note);
    if (!checked.ok) return { ok: false, name, reason: checked.reason };
    if (checked.note !== null && Object.hasOwn(values, name))
      notes[name] = checked.note;
  }
  return { ok: true, notes };
}
