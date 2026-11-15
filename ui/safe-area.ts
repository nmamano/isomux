// The top padding of a phone surface that reaches under the status bar
// (task d60726c7). iOS 26 blurs the page under the status bar and a little
// below it, past env(safe-area-inset-top), so content that starts at the
// inset reads as blurry. The clearance keeps it below that blur. It applies
// only when there is an inset: a screen without one keeps its look.

const INSET = "env(safe-area-inset-top, 0px)";
// Not measured on a device: the blur's extent past the inset is a guess.
const CLEARANCE_PX = 8;

// The inset plus the clearance, never less than floorPx.
export function phoneTopPad(floorPx = 0): string {
  // 0 with no inset, the clearance with any inset.
  const clearance = `min(${CLEARANCE_PX}px, ${INSET} * 1000)`;
  return `max(${floorPx}px, calc(${INSET} + ${clearance}))`;
}
