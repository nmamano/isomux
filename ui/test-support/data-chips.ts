// The values a sentence shows as data (ui/components/Data.tsx, AGENTS.md "UI
// rules"): the text of each Data chip under root, in order. A chip that page
// translation may touch is marked, so the assertion names what is wrong.
export function dataChips(root: ParentNode | null | undefined): string[] {
  if (!root) return ["(no root)"];
  return [
    ...root.querySelectorAll<HTMLElement>("[data-integrations-data]"),
  ].map((el) => {
    const text = el.textContent ?? "";
    const kept =
      el.getAttribute("translate") === "no" &&
      el.classList.contains("notranslate");
    return kept ? text : `(translatable) ${text}`;
  });
}
