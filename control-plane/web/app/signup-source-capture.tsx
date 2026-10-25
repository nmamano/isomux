"use client";

import { useEffect } from "react";
import { captureSignupSource } from "../lib/signup-source";

/** Keeps the signup source the page's URL or referrer names
 * (lib/signup-source.ts). Renders nothing. */
export function SignupSourceCapture(): null {
  useEffect(() => {
    try {
      captureSignupSource(
        window.location.href,
        document.referrer,
        window.localStorage,
        Date.now(),
      );
    } catch {
      // Storage can be off in a private window; the signup then has no source.
    }
  }, []);
  return null;
}
