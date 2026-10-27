import type { AppView } from "../shared/contract-shapes.ts";

// The path and the title come from the member's browser and the app's page:
// data the agent reads, never part of the label's own structure. Control
// characters (line breaks included) and brackets go, the value is cut, and
// JSON quoting escapes any quote, so a title cannot close the label or look
// like a member line (Isomux PM, 2026-10-27).
const PATH_MAX = 200;
const TITLE_MAX = 80;

function bounded(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f[\]()]/g, "");
  const chars = [...clean];
  return JSON.stringify(
    chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean,
  );
}

// The app part of the sender label, with the member's view when one came:
// App hello, page "/recipes/3", title "Pasta".
export function formatAppViewLabel(name: string, view?: AppView): string {
  if (!view) return `App ${name}`;
  const page = `App ${name}, page ${bounded(view.path, PATH_MAX)}`;
  const title = view.title?.trim();
  return !title ? page : `${page}, title ${bounded(title, TITLE_MAX)}`;
}
