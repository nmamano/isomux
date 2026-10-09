// One save rule for the page, its demo, and the API. Discovery remains
// permissive so files edited elsewhere stay available for repair.
import { parseDocument } from "yaml";
import type { PlainMessageKey } from "./i18n/translate.ts";

export function skillFileProblem(content: string): PlainMessageKey | null {
  const opening = /^\uFEFF?---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!opening) return "skills.invalid.frontmatter";
  const rest = content.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) return "skills.invalid.unclosed";
  let metadata: unknown;
  try {
    const document = parseDocument(rest.slice(0, closing.index), {
      prettyErrors: false,
    });
    if (document.errors.length) return "skills.invalid.yaml";
    metadata = document.toJS();
  } catch {
    return "skills.invalid.yaml";
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return "skills.invalid.mapping";
  const fields = metadata as Record<string, unknown>;
  if (typeof fields.name !== "string" || !fields.name.trim())
    return "skills.invalid.name";
  if (typeof fields.description !== "string" || !fields.description.trim())
    return "skills.invalid.description";
  return null;
}
