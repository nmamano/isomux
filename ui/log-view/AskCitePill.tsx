import { useEffect, useRef, useState } from "react";
import {
  CiteSelectionButton,
  PILL_GAP,
  PILL_HEIGHT,
} from "./CiteSelectionButton.tsx";
import { chatCitePinnedBox } from "./chat-cite-box.ts";
import type { CiteMode } from "./cite-mode.ts";
import type { CiteSelection } from "./useSelectionCite.ts";

// The Cite pill of an ask card (task ad4b51ac). Its own component, so a
// scroll re-renders the pill, not the card.
//
// With a mouse ("anchored") the pill sits next to the selection, within the
// card's sides and anywhere up and down the window: a prompt's first line has
// no room above it inside the card, and below it the pill would cover the
// next line. Any scroll moves the selection away from the pill, so it clears
// the cite.
//
// On iOS touch ("pinned"), in a chat's asks stack, the pill sits where the
// chat's own pill does: just above the message box at the right, even over
// the ask's text (chatCitePinnedBox; task 3d440170). In the Inbox, with no
// message box around the card, it sits just above the card's reply field at
// the right (task 1e119dfb), and never leaves the part of the card in view:
// with the field below the view it sits at the view's bottom, with the field
// above the view at the top of the card's visible part. It stays while the
// selection lasts: a scroll moves it with the card. While the card is out of
// its scroller's view there is no pill, so a tap never cites text the member
// cannot see.
export function AskCitePill({
  card,
  cite,
  mode,
  onCite,
  clearCite,
}: {
  card: HTMLElement;
  cite: CiteSelection;
  mode: Exclude<CiteMode, null>;
  onCite: () => void;
  clearCite: () => void;
}) {
  const [, setTick] = useState(0);
  const frame = useRef<number | null>(null);

  // Scroll events do not bubble: listen in the capture phase, for the Inbox
  // list, the asks stack and the page alike. A pinned pill updates once per
  // frame, as a momentum scroll sends many events.
  useEffect(() => {
    function onScroll() {
      if (mode === "anchored") {
        clearCite();
        return;
      }
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setTick((n) => n + 1);
      });
    }
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [mode, clearCite]);

  const box = card.getBoundingClientRect();
  if (mode === "anchored") {
    return (
      <CiteSelectionButton
        cite={cite}
        containerRect={new DOMRect(box.left, 0, box.width, window.innerHeight)}
        onClick={onCite}
      />
    );
  }
  const view = scrollerBox(card);
  if (box.bottom <= view.top || box.top >= view.bottom) return null;
  const composer = card.closest("[data-chat-composer]");
  const chatBox = composer && chatCitePinnedBox(composer);
  if (chatBox)
    return (
      <CiteSelectionButton
        cite={cite}
        containerRect={chatBox}
        onClick={onCite}
        pinned="bottom"
      />
    );
  const top = Math.max(box.top, view.top);
  const field = card.querySelector("textarea[data-ask-reply-input]");
  const above = field ? field.getBoundingClientRect().top : box.bottom;
  const bottom = Math.max(
    Math.min(above, view.bottom),
    top + PILL_HEIGHT + PILL_GAP,
  );
  return (
    <CiteSelectionButton
      cite={cite}
      containerRect={new DOMRect(box.left, top, box.width, bottom - top)}
      onClick={onCite}
      pinned="bottom"
    />
  );
}

// The top and bottom of the box that scrolls the card: its nearest ancestor
// that scrolls on the y axis, else the window.
function scrollerBox(card: HTMLElement): { top: number; bottom: number } {
  for (let el = card.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") {
      const { top, bottom } = el.getBoundingClientRect();
      return { top, bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
