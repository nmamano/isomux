// The primary pointer is a touch screen, whatever the window width. Decides
// what depends on the input device (autofocus, which opens the on-screen
// keyboard; Enter to send), never the layout. A touchscreen laptop stays a
// computer: this reads (pointer: coarse), never any-pointer.
export function isTouchPrimary(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}
