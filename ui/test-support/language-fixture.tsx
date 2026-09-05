// A self user on a language, for DOM tests.
//
// App mounts bare in the DOM tests, and the harness's seam for state is
// StateCtx.Provider (internal-docs/testing-guide.md, render tests). This module
// builds that state with one full user record and a session pointing at it, so
// useSelfUser finds the user and LanguageProvider reads their language. It
// imports ui/store.tsx, which touches the window at module scope, so a test
// loads it with `await import(...)` after setUpDomTestFile(), never statically.
//
// Assert literal translated text in the test that uses this, never text read
// back through translatorFor: an oracle that repeats the implementation approves
// a wrong translation.

import type { ReactElement } from "react";
import { StateCtx, initialState, type AppState } from "../store.tsx";
import { LanguageProvider } from "../i18n.tsx";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import type { SessionContext, UserRecord } from "../../shared/types.ts";

const SELF_ID = "u1";

/**
 * A complete UserRecord, so isFullUserView accepts it and a new private field
 * on the record breaks this fixture at compile time rather than making
 * useSelfUser silently return null.
 */
export function selfUserRecord(
  language: SupportedLanguageCode | null,
): UserRecord {
  return {
    id: SELF_ID,
    name: "Tester",
    notifRooms: [],
    envFile: null,
    createdAt: 0,
    role: "owner",
    avatarColor: "#4a90d9",
    avatarVariant: "classic",
    allowedRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    language,
  };
}

/**
 * initialState with the self user on `language` (null = never chose one, so
 * the browser language decides, which under happy-dom is en-US). `over` sets
 * anything else the test needs on the state, such as the mobile viewport.
 */
export function stateWithSelfUser(
  language: SupportedLanguageCode | null,
  over: Partial<AppState> = {},
): AppState {
  const record = selfUserRecord(language);
  const sessionContext: SessionContext = {
    userId: SELF_ID,
    username: record.name,
    role: record.role,
    currentSessionPrefix: "00000000",
    connectionId: "c1",
  };
  return {
    ...initialState,
    users: new Map([[record.name.toLowerCase(), record]]),
    sessionContext,
    ...over,
  };
}

/** `element` under the store state of stateWithSelfUser and the language provider. */
export function onLanguage(
  language: SupportedLanguageCode | null,
  element: ReactElement,
  over: Partial<AppState> = {},
): ReactElement {
  return (
    <StateCtx.Provider value={stateWithSelfUser(language, over)}>
      <LanguageProvider>{element}</LanguageProvider>
    </StateCtx.Provider>
  );
}
