// Reads the Slide Mode gate. Task 49d4e2f6 moved it off this device's
// localStorage onto the user record, so it follows a boss to their phone; the
// value now arrives (and re-arrives on every change) through the same
// user_self_updated event as the rest of their record, which is why this needs
// no subscription of its own any more.
//
// Off until the record lands, so a slow first paint shows chat rather than
// flashing a deck the user may not have enabled.

import { useSelfUser } from "./useSelfUser.ts";

export function useSlideModeEnabled(): boolean {
  return useSelfUser()?.slideMode === true;
}
