// Display-only shortening of a working directory: `/home/nil/nil/isomux` reads
// as `~/nil/isomux`. The shared cwd display surfaces go through this - desk
// nameplates, the log-view headers (desktop and mobile), the cron run header,
// and the recent-cwd chips in the spawn/edit and cronjob dialogs - so they
// cannot drift apart the way they had (tasks 925af43c, aa98b2fb). Not every
// path on screen is one of them: DiffCard renders a tool payload's cwd raw.
//
// Never use it on a value being sent back to the server: `~` is expanded
// server-side (plugins.ts), but the round trip is only safe for the caller's
// OWN home, and nothing here knows whose path it is rendering.
export function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/home\/[^/]+/, "~");
}
