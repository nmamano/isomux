// How big a reference page is as an agent receives it. No imports: the gate's
// headroom check (scripts/reference-headroom.ts) loads it in a checkout whose
// page files it reads from git, not from disk.

// A page that grows past the cap is cut first, then split into a sub-page.
// Raising the cap needs Nil (task 215ae677).
export const AGENT_REFERENCE_PAGE_CAP = 8_192;
// Over this share of the cap, CI warns, and the gate fails a diff that makes
// the page grow (tasks 3e3b0f81, f3858003).
export const AGENT_REFERENCE_WARN_AT = 0.9;

// Prettier pads route tables to align their columns; an agent pays for that
// padding in tokens. The served form drops it and keeps every cell's text.
// A cell ends at an unescaped "|"; a separator row holds only "|", "-", ":"
// and spaces. Lines in a ``` fence stay as they are.
export function compactReferenceTables(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced || !line.startsWith("|")) return line;
      const separator = /^[|:\- ]*$/.test(line) && line.includes("-");
      const cells = line.split(/(?<!\\)\|/);
      return cells
        .map((cell, i) => {
          if (i === 0 || i === cells.length - 1) return cell;
          const trimmed = cell.replace(/ {2,}$/, " ");
          return separator ? trimmed.replace(/-+/g, "---") : trimmed;
        })
        .join("|");
    })
    .join("\n");
}
