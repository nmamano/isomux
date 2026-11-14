// Where the chat's Cite pill goes on this device, or null when Cite is off.
//
// A web page cannot add an item to the OS selection menu, so Cite stays our
// own pill. A mouse or trackpad gets it next to the selection ("anchored").
// On iOS and iPadOS touch it is pinned to a corner of the chat ("pinned"):
// next to the selection it would sit under the native menu and handles.
// Other touch platforms have no Cite until it is proven on a real device
// (Nil, 2026-11-14: "better not to have it than to have a janky version").

import { isIos } from "../push-subscription.ts";
import { isTouchPrimary } from "../touch-primary.ts";

export type CiteMode = "anchored" | "pinned" | null;

export type CiteEnv = {
  coarsePointer: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
};

export function citeMode(env: CiteEnv): CiteMode {
  if (!env.coarsePointer) return "anchored";
  return isIos(env) ? "pinned" : null;
}

export function citeModeHere(): CiteMode {
  return citeMode({
    coarsePointer: isTouchPrimary(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}
