// The extension's translator. The build keeps only the browser.* catalog keys
// (extensionCatalogs in scripts/build-browser-extension.ts), so the key types
// here stop a key the extension build would not ship.
import {
  CATALOGS,
  lookupIn,
  templateParts,
  translatorFor,
} from "../shared/i18n/translate";
import type {
  MessageKey,
  ParamsFor,
  PlainMessageKey,
  TemplatePiece,
} from "../shared/i18n/translate";
import type { SupportedLanguageCode } from "../shared/languages";

export type ExtensionKey = Extract<MessageKey, `browser.${string}`>;
export type ExtensionPlainKey = Extract<PlainMessageKey, `browser.${string}`>;

const code = navigator.language.split("-")[0];
export const language: SupportedLanguageCode =
  code in CATALOGS ? (code as SupportedLanguageCode) : "en";
export const t: <K extends ExtensionKey>(
  key: K,
  ...params: ParamsFor<K>
) => string = translatorFor(language).t;

// The rich form of t() for the popup: el gets the sentence as text nodes, each
// placeholder value in a span.data (connection.css), never as markup.
export function setRich<K extends ExtensionKey>(
  el: HTMLElement,
  key: K,
  ...params: ParamsFor<K>
): void {
  const values = (params[0] ?? {}) as Record<string, string | number>;
  const nodes: Node[] = [];
  const piece = (p: TemplatePiece) => {
    if (typeof p === "string") return nodes.push(document.createTextNode(p));
    if (!(p.name in values)) {
      return nodes.push(document.createTextNode(`{${p.name}}`));
    }
    const span = document.createElement("span");
    span.className = "data";
    span.textContent = String(values[p.name]);
    nodes.push(span);
  };
  for (const part of templateParts(
    lookupIn(CATALOGS[language], CATALOGS.en, key),
  )) {
    // The popup's keys carry no tag pair; a tag's words show as text.
    if (typeof part !== "string" && "tag" in part) part.inner.forEach(piece);
    else piece(part);
  }
  el.replaceChildren(...nodes);
}
