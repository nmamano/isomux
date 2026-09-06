"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  languageFromCookie,
  type SupportedLanguageCode,
} from "./languages";
import { translatorFor } from "./translate";
import { writeLanguageCookie } from "./use-language";

/**
 * Where the switch does not appear.
 *
 * A pure function so the rule can be tested without a router: the operator floor
 * is English (S11 scope), and offering a language there would offer one its
 * pages do not have. A null pathname is the router before it has one, and the
 * bar is drawn on every other page.
 */
export function hidesLanguageSwitch(pathname: string | null): boolean {
  return pathname === "/ops" || (pathname?.startsWith("/ops/") ?? false);
}

/**
 * The language switch, in the topbar, on the customer pages only.
 *
 * OPS IS EXCLUDED (reviewer's condition, 2026-09-06): the operator floor is
 * English, and a switch there would offer a language its pages do not have.
 *
 * WHAT IT MARKS AS ACTIVE is the document's own `lang`, watched rather than
 * recomputed. A page in this app arrives at its language two different ways -
 * the server resolves it for `/signup` and `/office`, the browser resolves it
 * for the two prerendered pages - and a switch that resolved a third time could
 * disagree with the page it sits above. `DocumentLanguage` is the one writer of
 * that attribute, so following it is the only reading that cannot drift.
 *
 * Choosing writes the cookie and RELOADS. A reload is what a server-rendered
 * page needs to come back in the new language, and it costs a prerendered page
 * nothing it would not have paid to re-resolve.
 */
export function LanguageSwitch() {
  const pathname = usePathname();
  const [active, setActive] = useState<SupportedLanguageCode>(DEFAULT_LANGUAGE);

  useEffect(() => {
    const read = (): void =>
      setActive(
        languageFromCookie(document.documentElement.lang) ?? DEFAULT_LANGUAGE,
      );
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    });
    return () => observer.disconnect();
  }, []);

  if (hidesLanguageSwitch(pathname)) return null;

  const choose = (code: SupportedLanguageCode): void => {
    writeLanguageCookie(code);
    location.reload();
  };

  return (
    <nav
      className="language-switch"
      aria-label={translatorFor(active).t("language.label")}
      data-testid="language-switch"
    >
      {SUPPORTED_LANGUAGES.map((option) => (
        <button
          key={option.code}
          type="button"
          lang={option.code}
          data-testid={`language-${option.code}`}
          aria-current={option.code === active ? "true" : undefined}
          onClick={() => choose(option.code)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  );
}
