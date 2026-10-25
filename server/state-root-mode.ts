// The state root (server/config.ts) holds agent transcripts, office config and
// every member's credentials. Its own mode is the fence against other OS
// users: a 0700 root closes the whole tree, whatever the modes below it.
// runOfficeMain calls this at each start, so a root created at the ambient
// umask (0775 is common) on an existing install is closed at the first
// restart after the update.

import { chmodSync, mkdirSync, statSync } from "fs";
import { STATE_ROOT } from "./config.ts";

// Creates the root at 0700, or sets an existing root with group or other bits
// to 0700. Logs one line when it changes the mode. Never throws: an error is
// a warning and the office still starts.
export function secureStateRoot(root: string = STATE_ROOT): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const mode = statSync(root).mode & 0o7777;
    // Execute alone lets another user reach a path whose name they can guess.
    if ((mode & 0o077) === 0) return;
    chmodSync(root, 0o700);
    console.log(
      `[state-root] restricted ${root} to 0700 (was 0${mode.toString(8)})`,
    );
  } catch (err) {
    console.warn(
      `[state-root] could not restrict ${root} to 0700: ${(err as Error).message}`,
    );
  }
}
