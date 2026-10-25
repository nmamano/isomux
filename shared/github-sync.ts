// What the GitHub issues sync (server/github-sync.ts) and its Integrations
// tab both need: the tab lists only the secrets the sync will send.

// The host the sync calls; a secret must list it exactly.
export const GITHUB_HOST = "api.github.com";
// The office secret a link uses when it names none.
export const DEFAULT_GITHUB_SYNC_SECRET = "GITHUB_SYNC_TOKEN";
