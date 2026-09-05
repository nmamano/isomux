// The one language context of the UI (internal-docs/i18n-loop.md, ruling 8).
//
// The language is whatever ui/preference-form.ts says is in effect for the
// signed-in user - their explicit preference, else the browser's language, else
// English - which is the same answer the Preferences picker shows. There is no
// second resolver: this provider only asks displayLanguage and hands the
// matching translator down.
//
// Composed in ui/index.tsx and ui/demo-entry.tsx, inside StoreProvider and
// directly around the app, because the self user lives in the store. A tree
// with no provider gets the English translator from the context default; the
// DOM tests that mount App bare rely on that, and
// ui/test-support/language-fixture.tsx is how a test puts a user on a language.
//
// Components call `const { t } = useI18n()`. A pure module that builds strings
// takes `t` or the language as an argument and never reads a global.

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LANGUAGE } from "../shared/languages.ts";
import { translatorFor, type Translator } from "../shared/i18n/translate.ts";
import { displayLanguage } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";

const I18nCtx = createContext<Translator>(translatorFor(DEFAULT_LANGUAGE));

export function LanguageProvider({ children }: { children: ReactNode }) {
  const self = useSelfUser();
  const language = displayLanguage(
    self,
    typeof navigator === "undefined" ? null : navigator.language,
  );
  // translatorFor returns one object per language, so the context value only
  // changes identity when the language does, and consumers re-render then.
  return (
    <I18nCtx.Provider value={translatorFor(language)}>
      {children}
    </I18nCtx.Provider>
  );
}

export function useI18n(): Translator {
  return useContext(I18nCtx);
}
