"use client";

import { useEffect, useRef, useState } from "react";
import type { OfficeCard, SessionView } from "./session-view";

/**
 * The probe the static shells run after they paint.
 *
 * FOUR STATES, and `unavailable` is not `signed-out`. A probe that could not
 * reach the route has learned nothing about the visitor, and collapsing the two
 * would make a transient failure look like an answer - on `/signin` that strands
 * a signed-in visitor in front of a sign-in form for the life of the document,
 * which is the shape of the defect measured on 2026-08-11. Both pages still DRAW
 * the signed-out shell while unavailable, because there is nothing else they
 * could honestly draw; the difference is that the hook keeps trying.
 *
 * It tries again once on its own, and again whenever the tab comes back to the
 * front, but only while it has no answer: a resolved probe does not re-ask on
 * every focus.
 */

export type SessionProbe =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "signed-out" }
  | { state: "signed-in"; email: string | null; offices: OfficeCard[] | null };

/** Long enough for a dropped request or a route cold start, short enough that a
 * signed-in visitor does not read the marketing copy first. */
const RETRY_DELAY_MS = 1000;

export function useSessionProbe(options?: { offices?: boolean }): SessionProbe {
  const wantsOffices = options?.offices === true;
  const [probe, setProbe] = useState<SessionProbe>({ state: "loading" });
  const answered = useRef(false);

  useEffect(() => {
    let live = true;
    const url = wantsOffices ? "/api/session?offices=1" : "/api/session";

    /** True when the route answered. `cache: "no-store"` because the browser's
     * own cache is as wrong a place to keep this as a CDN is. */
    const ask = async (): Promise<boolean> => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return false;
        const view = (await response.json()) as SessionView;
        answered.current = true;
        if (live) {
          setProbe(
            view.signedIn
              ? {
                  state: "signed-in",
                  email: view.email,
                  offices: view.offices,
                }
              : { state: "signed-out" },
          );
        }
        return true;
      } catch {
        return false;
      }
    };

    const run = async (): Promise<void> => {
      if (await ask()) return;
      if (!live) return;
      setProbe({ state: "unavailable" });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (live) await ask();
    };

    void run();

    const retryWhenVisible = (): void => {
      if (!answered.current && document.visibilityState === "visible") {
        void ask();
      }
    };
    document.addEventListener("visibilitychange", retryWhenVisible);
    window.addEventListener("focus", retryWhenVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", retryWhenVisible);
      window.removeEventListener("focus", retryWhenVisible);
    };
  }, [wantsOffices]);

  return probe;
}
