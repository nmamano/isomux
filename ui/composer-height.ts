// The chat composers grow with the draft up to a cap, then scroll. On a phone
// the open keyboard leaves little screen, so the cap there is eight lines
// (20px line height plus the 4px bottom padding the composers share).
const DESKTOP_MAX_HEIGHT = 200;
const MOBILE_MAX_HEIGHT = 8 * 20 + 4;

// The mobile size matches the message text in the chat log.
export const COMPOSER_MOBILE_FONT_SIZE = 15;

export function composerMaxHeight(isMobile: boolean | undefined): number {
  return isMobile ? MOBILE_MAX_HEIGHT : DESKTOP_MAX_HEIGHT;
}

export function fitComposer(
  el: HTMLTextAreaElement,
  isMobile: boolean | undefined,
): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, composerMaxHeight(isMobile))}px`;
}
