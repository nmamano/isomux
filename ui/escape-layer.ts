import { resetBetweenTestFiles } from "./test-file-resets.ts";

// Escape for overlays that sit above a page (task 3d947224). Pages close
// themselves on Escape from a capture-phase keydown listener on window, and
// listeners on one target run in the order they were added, so a page's
// listener ran before the listener of an overlay that opened above it and
// closed the page too. This module adds its one listener when it is first
// evaluated, before any component effect, so it runs first: while an overlay
// holds a claim, Escape closes only the top overlay and no other listener
// sees the key.

const claims: { close: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = claims.at(-1);
  if (!top) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  top.close();
}

// A second add of the same listener does nothing. No "already installed"
// check: a DOM test file's new window can be the same global object.
function install() {
  if (typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown, true);
}

install();
// A DOM test file gets a new window, while this module stays evaluated.
resetBetweenTestFiles(() => {
  claims.length = 0;
  install();
});

/** Escape closes this overlay, and only it, until the returned release is
 * called. The latest claim is the top one. */
export function claimEscape(close: () => void): () => void {
  const claim = { close };
  claims.push(claim);
  return () => {
    const at = claims.indexOf(claim);
    if (at !== -1) claims.splice(at, 1);
  };
}
